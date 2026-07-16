// Dev tools only exist off production — previews and localhost. Gates the
// stats seeder (Stats.jsx) and the run-reset button (Game.jsx).
export const DEV =
  typeof window !== "undefined" && window.location.hostname !== "incidle.com";
