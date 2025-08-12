import { createRoot } from "react-dom/client"
import "./index.css"
import LiveChat from "@/components/live-chat"
import { HeliaProvider } from "@/provider/HeliaProvider"

createRoot(document.getElementById("root")!).render(
  <HeliaProvider>
    <LiveChat isGeneral />
  </HeliaProvider>
)
