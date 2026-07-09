import React from "react";
import { createRoot } from "react-dom/client";
import Incidle from "./App.jsx";
import { upgradeLegacyHash } from "./router.jsx";
import "./styles.css";

upgradeLegacyHash();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Incidle />
  </React.StrictMode>
);
