// One action — revealing an observation or testing a hypothesis — burns one
// hour; at T+HOURS the incident escalates. Shared by the client (Game.jsx)
// and the server-side move endpoint (api/action.js), which uses it to
// decide when the reveal ships.
export const HOURS = 7;
