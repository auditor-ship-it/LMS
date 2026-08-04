# Auth — standalone, no cross-project coupling

`client.js`, `auth.api.js`, and `AuthContext.jsx` in this folder are real,
independent implementations — not re-exports of `../../../../frontend`'s
code. This app runs against its own backend (`lease-management/backend/`,
port 4001 by default — see `client.js`'s `VITE_API_URL`), with its own axios
instance, its own login/session calls, and its own React auth context. They
started as a copy of the main app's equivalent files (same login API shape,
same session/token handling), but this app owns them now — changes here
never touch, and are never touched by, `frontend/`.

Every other file in this app imports from `src/shared/auth/index.js`, same
as before — that convention didn't change, only what's behind it did.
