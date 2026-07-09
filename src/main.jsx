import React from "react";
import { createRoot } from "react-dom/client";
import Incidle from "./App.jsx";
import { upgradeLegacyUrl } from "./router.jsx";
import "./styles.css";

upgradeLegacyUrl();

createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <Incidle />
  </React.StrictMode>
);
