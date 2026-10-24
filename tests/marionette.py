"""Small dependency-free client for the Gecko automation protocol."""
import json
import socket
import time


class Marionette:
    def __init__(self, port):
        self.socket = socket.create_connection(("127.0.0.1", port), timeout=40)
        self.sequence = 0
        self.read()
        self.call("WebDriver:NewSession", {"capabilities": {"alwaysMatch": {}}})
        self.call("Marionette:SetContext", {"value": "chrome"})
        self.call("WebDriver:SetTimeouts", {"script": 30000})

    def read(self):
        size = b""
        while not size.endswith(b":"):
            data = self.socket.recv(1)
            if not data:
                raise RuntimeError("Thunderbird closed the automation connection")
            size += data
        remaining = int(size[:-1])
        parts = []
        while remaining:
            data = self.socket.recv(remaining)
            if not data:
                raise RuntimeError("Incomplete automation response")
            parts.append(data)
            remaining -= len(data)
        return json.loads(b"".join(parts))

    def call(self, name, params=None):
        self.sequence += 1
        payload = json.dumps([0, self.sequence, name, params or {}]).encode()
        self.socket.sendall(str(len(payload)).encode() + b":" + payload)
        response = self.read()
        if response[2]:
            raise RuntimeError(json.dumps(response[2], indent=2))
        return response[3]

    def script(self, code, *args):
        result = self.call("WebDriver:ExecuteScript", {"script": code, "args": list(args), "newSandbox": False, "sandbox": "default"})
        return result.get("value")

    def async_script(self, code, *args):
        source = "const done = arguments[arguments.length - 1]; (async () => {" + code + "})().then(value => done({result: value}), error => done({error: String(error), stack: error.stack}));"
        result = self.call("WebDriver:ExecuteAsyncScript", {"script": source, "args": list(args), "newSandbox": False, "sandbox": "default"}).get("value")
        if result and "error" in result:
            raise RuntimeError(json.dumps(result, indent=2))
        return result.get("result") if result else None

    def wait(self, code, timeout=15):
        end = time.monotonic() + timeout
        while time.monotonic() < end:
            result = self.script(code)
            if result:
                return result
            time.sleep(.1)
        raise AssertionError(f"Timed out: {code}")

    def page(self, path, code, *args):
        code = "return (async () => {" + code + "})();"
        return self.async_script("""
          const view = [...testExtension.views].find(v => v.uri?.spec === testExtension.baseURI.resolve(arguments[0]));
          if (!view) throw new Error('Extension view unavailable: ' + arguments[0]);
          return await view.browsingContext.currentWindowGlobal.getActor('MarionetteCommands').executeScript(
            arguments[1], arguments[2], {sandboxName: 'default', newSandbox: false, timeout: 25000});
        """, path, code, list(args))

    def background(self, code, *args):
        return self.page("background/background.html", code, *args)
