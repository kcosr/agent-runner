import ReactDOM from "react-dom/client";
import { App } from "./app.js";
import "./styles.css";

const rootElement = document.getElementById("root");

if (!rootElement) {
  throw new Error("Root element #root was not found");
}

ReactDOM.createRoot(rootElement).render(<App />);
