// async.js
//
// Promise and HTTP-error helpers shared by the component and service tests.

/** A promise the test settles by hand, to hold a request in flight. */
export function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

/**
 * An error shaped like the one axios rejects with for a non-2xx answer.
 * `data` is left off the response when not given, so a bare status keeps the old shape.
 */
export function httpError(status, data) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: data === undefined ? { status } : { status, data },
  });
}
