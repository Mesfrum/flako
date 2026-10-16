import { StrictMode } from "react";
import ReactDOM from "react-dom/client";
import { HashRouter } from "react-router-dom";
import App from "./App";
import "./index.css";
import { legacyPathToHash } from "./routing";

const legacy = legacyPathToHash(location.pathname, location.search, location.hash);
if (legacy) {
  location.replace(legacy);
} else {
  ReactDOM.createRoot(document.getElementById("root")!).render(
    <StrictMode>
      <HashRouter>
        <App />
      </HashRouter>
    </StrictMode>,
  );
}
