// The roles a browser holds with the publishable key. Only the backend's
// service_role may call the SECURITY INVOKER functions, so these must not.
export const CLIENT_ROLES = ['anon', 'authenticated'];

// Which of `roles` may EXECUTE the function, in the order asked. `fn` is a
// signature such as 'cancel_flagged_booking(uuid, uuid, text)' or an oid,
// so an overload is named exactly and a missing function is an error.
export async function clientsCanExecute(db, fn, roles = CLIENT_ROLES) {
  const { rows } = await db.query(
    `select role, has_function_privilege(role, $1::regprocedure, 'execute') as allowed
       from unnest($2::text[]) with ordinality as r(role, n) order by n`,
    [fn, roles],
  );
  return rows.filter((row) => row.allowed).map((row) => row.role);
}
