// Stand-ins for the supabase-js client shared by the route, service and flow
// tests. Each family keeps the recording shape its tests assert on, so a test
// that moved here sees exactly the calls it saw before.

import { vi } from 'vitest';

export const ok = (data) => ({ data, error: null });
export const fail = (error) => ({ data: null, error });
// A head: true count query answers with no rows, only a count.
export const counted = (count) => ({ data: null, count, error: null });
/** A Postgres failure, shaped as supabase-js surfaces it. */
export const dbError = (code, message, extra = {}) => ({ data: null, error: { code, message, ...extra } });

/** Await a rejection and hand back the error, or null if it resolved. */
export async function errorFrom(promise) {
  try {
    await promise;
    return null;
  } catch (err) {
    return err;
  }
}

// The union of every builder method the services chain. A method a test never
// expects is still recorded, so a stray call fails an assertion, not a TypeError.
const CHAIN_METHODS = [
  'select', 'insert', 'update', 'delete',
  'eq', 'neq', 'is', 'in', 'ilike', 'gt', 'gte', 'lt', 'lte', 'not', 'order', 'limit',
];

function recordingBuilder(settle) {
  const calls = [];
  const stub = {
    calls,
    /** Was this builder method used at all? */
    called: (method) => calls.some(([name]) => name === method),
    /** The arguments of its first call. */
    args: (method) => calls.find(([name]) => name === method)?.slice(1),
    /** Every call to it, in order, for a method used more than once. */
    allArgs: (method) => calls.filter(([name]) => name === method).map((c) => c.slice(1)),
  };
  for (const method of CHAIN_METHODS) {
    stub[method] = (...args) => { calls.push([method, ...args]); return stub; };
  }
  for (const method of ['single', 'maybeSingle']) {
    stub[method] = (...args) => { calls.push([method, ...args]); return settle(); };
  }
  // Thenable because supabase-js resolves the chain itself: a list query ends
  // at .order() with no terminal method.
  stub.then = (onFulfilled, onRejected) => settle().then(onFulfilled, onRejected);
  return stub;
}

/**
 * A query builder that records every call and answers `result`. `result` must
 * stay a plain object: resolving a promise with a thenable re-enters unwrapping.
 */
export function queryStub(result) {
  return recordingBuilder(() => Promise.resolve(result));
}

/**
 * The flow tests' builder for one scripted step. `step.assert(stub)` runs when
 * the chain is awaited, and a failure is pushed onto `failures` rather than
 * thrown inside the service, so the flow reports it by name.
 */
export function scriptedQueryStub(step, failures) {
  const stub = recordingBuilder(() => {
    try {
      step.assert?.(stub);
    } catch (err) {
      failures.push(err);
    }
    return Promise.resolve(step.respond);
  });
  return stub;
}

/**
 * An rpc-only client answering queued { data, error } pairs in call order and
 * recording each { fn, args }. Running out throws, so an extra round trip fails.
 */
export function createRpcQueueClient(results = []) {
  const queue = [...results];
  const calls = [];
  return {
    calls,
    rpc(fn, args) {
      calls.push({ fn, args });
      if (queue.length === 0) throw new Error(`fake client: no result queued for ${fn}`);
      return Promise.resolve(queue.shift());
    },
  };
}

/**
 * A read-only from() client recording one entry per query, each filter kind in
 * its own list, and answering queued { data, error } pairs in call order.
 */
export function createReadQueueClient(results = []) {
  const queue = [...results];
  const calls = [];

  function settle(call) {
    if (queue.length === 0) {
      throw new Error(`fake client: no result queued for ${call.operation} on ${call.table}`);
    }
    return Promise.resolve(queue.shift());
  }

  return {
    calls,
    from(table) {
      const call = { table, operation: 'select', select: null, filters: [], inFilters: [], notFilters: [], order: [] };
      calls.push(call);
      const chain = {
        select(columns = '*') { call.select = columns; return chain; },
        eq(column, value) { call.filters.push([column, value]); return chain; },
        in(column, values) { call.inFilters.push([column, [...values]]); return chain; },
        not(column, operator, value) { call.notFilters.push([column, operator, value]); return chain; },
        order(column, options) { call.order.push([column, options]); return chain; },
        maybeSingle: () => settle(call),
        single: () => settle(call),
        then: (resolve, reject) => settle(call).then(resolve, reject),
      };
      return chain;
    },
  };
}

/**
 * The event-request client: from() reads and writes and rpc() share one queue
 * and one ordered `calls` log, so "read, then call the function, and nothing
 * else" is a single assertion. insert/update set the recorded operation.
 */
export function createEventRequestClient(results = []) {
  const queue = [...results];
  const calls = [];

  function settle(call) {
    if (queue.length === 0) {
      throw new Error(
        `fake client: no result queued for ${call.operation} on ${call.table ?? call.fn}`,
      );
    }
    return Promise.resolve(queue.shift());
  }

  function builder(call) {
    const chain = {
      insert(payload) {
        call.operation = 'insert';
        call.payload = payload;
        return chain;
      },
      update(payload) {
        call.operation = 'update';
        call.payload = payload;
        return chain;
      },
      // On a read this names the columns; after insert/update it only asks for
      // the row back. Recorded either way, never treated as the operation.
      select(columns = '*') {
        call.select = columns;
        return chain;
      },
      eq(column, value) {
        call.filters.push([column, value]);
        return chain;
      },
      in(column, values) {
        call.filters.push([column, values]);
        return chain;
      },
      // Recorded in call order: which column is sorted on first is what
      // "most recently changed first" means.
      order(column, options) {
        call.order.push([column, options]);
        return chain;
      },
      single: () => settle(call),
      maybeSingle: () => settle(call),
      then: (resolve, reject) => settle(call).then(resolve, reject),
    };
    return chain;
  }

  return {
    calls,
    from(table) {
      const call = {
        table,
        operation: 'select',
        payload: null,
        select: null,
        filters: [],
        order: [],
      };
      calls.push(call);
      return builder(call);
    },
    rpc(fn, args) {
      const call = {
        table: null,
        operation: 'rpc',
        fn,
        args,
        payload: null,
        select: null,
        filters: [],
        order: [],
      };
      calls.push(call);
      return settle(call);
    },
  };
}

/**
 * A client answering rpc() by function name. An unscripted name gets
 * `fallback()`, called per call so no two answers share an object; a scripted
 * function answer is called with the args. from() answers `table(name)`.
 */
export function rpcByNameClient({ rpc = {}, fallback, table = () => ok([]) }) {
  const rpcCalls = [];
  const fromCalls = [];
  return {
    rpcCalls,
    fromCalls,
    rpc: vi.fn(async (name, args) => {
      rpcCalls.push({ name, args });
      const answer = rpc[name];
      if (answer === undefined) return fallback();
      return typeof answer === 'function' ? answer(args) : answer;
    }),
    from: vi.fn((name) => {
      fromCalls.push(name);
      return queryStub(table(name));
    }),
  };
}
