// Static, serverless preview of the editor + reel engine on the demo project.
// Built by scripts/build-preview.ts; everything runs in the browser.
(globalThis as { __PC_FILE_BASE?: string }).__PC_FILE_BASE = "./api/files/";
import { createRoot } from "react-dom/client";
import { PreviewEditor, type DemoData } from "./PreviewEditor";

declare const __DEMO__: DemoData;
createRoot(document.getElementById("app")!).render(<PreviewEditor data={__DEMO__} />);
