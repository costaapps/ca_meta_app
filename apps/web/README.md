# Meta portal web app

## Portal entry and legacy routes

The portal loads its access page and authenticated views lazily. The authenticated shell is protected by the server session guard; a browser context reference or route parameter does not grant membership.

Legacy Msg4 entry points are retained as redirects:

| Legacy route | Current behavior |
| --- | --- |
| `/setup` | Redirects to authenticated `/connections`; without a session, entry goes through `/access`. |
| `/channels` | Redirects to authenticated `/connections`; without a session, entry goes through `/access`. |
| `/setup/callback` and product callback routes | Redirect to `/connections`; callback query values do not establish a connection. |
| `/setup/coexistence` | Retained behind the authenticated portal shell while the onboarding migration is in progress. |

The entry request contract accepts only an email address. The browser keeps a short-lived allowlisted return path locally so the link may be completed in another tab; it is not sent to the API and is not proof of identity, membership or tenant authority. The server-issued session and its membership checks remain authoritative. The normal flow removes the path when an authenticated view resolves it, but concurrent tabs can repeat the same local navigation because browser storage does not provide atomic consumption. Repeating it has no external effect and the route guard/server still checks the session. Expired paths are discarded.
