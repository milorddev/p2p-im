import { createHelia, type Helia } from "helia"
import { createLibp2p } from "libp2p"
import { webTransport } from "@libp2p/webtransport"
import { webSockets } from "@libp2p/websockets"
import { bootstrap } from "@libp2p/bootstrap"
import { delegatedHTTPRouting } from "@helia/routers"
import type { IDBBlockstore } from "blockstore-idb"

// Optional persistent blockstore (browser IndexedDB)
let hasIDB = true
try {
  hasIDB = typeof indexedDB !== "undefined"
} catch {
  hasIDB = false
}

export async function createHeliaNode(): Promise<Helia> {
  let blockstore: IDBBlockstore | undefined
  if (hasIDB) {
    try {
      const { IDBBlockstore } = await import("blockstore-idb")
      blockstore = new IDBBlockstore("p2p-im-blocks")
      await blockstore.open()
    } catch (e) {
      console.warn("IDB blockstore unavailable, falling back to in-memory:", e)
    }
  }

  const libp2p = await createLibp2p({
    transports: [webTransport() as any, webSockets() as any],
    peerDiscovery: [
      bootstrap({
        list: [
          "/dns4/node0.delegate.ipfs.io/tcp/443/wss/p2p/12D3KooWGaDo7oU5zWxZmfZbduCMsZbxTWdK5vCq1zg9ZDB6wq3J",
        ],
      }),
    ],
  })

  libp2p.addEventListener("peer:connect", (evt) => {
    console.log("libp2p connected to", evt.detail.toString())
  })
  libp2p.addEventListener("peer:disconnect", (evt) => {
    console.log("libp2p disconnected from", evt.detail.toString())
  })

  return await createHelia({
    blockstore,
    libp2p,
    routers: [delegatedHTTPRouting('https://delegated-ipfs.io')],
  })
}
