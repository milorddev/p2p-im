import { useContext } from "react"
import { HeliaContext } from "@/provider/HeliaProvider"

export const useHelia = () => useContext(HeliaContext)
