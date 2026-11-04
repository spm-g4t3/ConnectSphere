// authStorageKey.js
//
// The sessionStorage key AuthContext writes { user, session } under and
// apiClient reads the token from. Its own module so apiClient need not import
// AuthContext, which imports apiClient.

export const AUTH_STORAGE_KEY = "connectsphere_auth";
