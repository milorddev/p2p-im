import { createRoot } from "react-dom/client"
import "./index.css"
import LiveChat from "@/components/live-chat"

createRoot(document.getElementById("root")!).render(
  <LiveChat isGeneral />
)
