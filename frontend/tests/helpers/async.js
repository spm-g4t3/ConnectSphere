// async.js
//
// Promise helpers shared by the notification tests.

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

/** An error shaped like the one axios rejects with for a non-2xx answer. */
export function httpError(status) {
  return Object.assign(new Error(`Request failed with status code ${status}`), {
    response: { status },
  });
}
