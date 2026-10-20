// fieldErrors.js
//
// The wiring that ties each form control to the list of errors under it. Every
// form builds it the same way, so the ids and aria-describedby strings agree.

/**
 * @param {string} idPrefix  from useId(), so two forms on a page never clash
 * @param {Array<{ field: string, message: string }>} errors  client and server errors together
 * @returns {{ messagesFor: Function, errorId: Function, ariaFor: Function }}
 */
export function fieldErrorWiring(idPrefix, errors) {
  function messagesFor(field) {
    return errors.filter((err) => err.field === field).map((err) => err.message);
  }

  function errorId(field) {
    return `${idPrefix}-${field}-error`;
  }

  /**
   * aria wiring for one control: invalid and described by its errors, or
   * neither. Errors come before any hint ids, so they are read first.
   */
  function ariaFor(field, hintIds = []) {
    const hasErrors = messagesFor(field).length > 0;
    const describedBy = [...(hasErrors ? [errorId(field)] : []), ...hintIds];
    return {
      "aria-invalid": hasErrors ? "true" : undefined,
      "aria-describedby": describedBy.length > 0 ? describedBy.join(" ") : undefined,
    };
  }

  return { messagesFor, errorId, ariaFor };
}
