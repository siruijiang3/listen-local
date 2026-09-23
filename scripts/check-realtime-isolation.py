"""Non-destructive checks while a browser owns the service."""
import asyncio
import json
from websockets.asyncio.client import connect
from websockets.exceptions import InvalidStatus
async def main():
    try:
        async with connect("ws://127.0.0.1:8765",origin="https://example.org"):
            raise AssertionError("Cross-origin connection accepted")
    except InvalidStatus as error:
        assert error.response.status_code==403
        print("PASS: foreign Origin rejected at handshake")
    async with connect("ws://127.0.0.1:8765",origin="http://127.0.0.1:4173") as ws:
        assert json.loads(await ws.recv())["type"]=="hello"
        await ws.send(json.dumps(dict(type="prepare")))
        reply=json.loads(await ws.recv())
        assert reply["type"]=="error" and "另一页面" in reply["message"]
        print("PASS: concurrent model owner rejected without changing active run")
asyncio.run(main())
