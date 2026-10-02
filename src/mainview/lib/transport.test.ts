import { describe, expect, test } from "bun:test";
import { createTransport } from "./transport";

describe("KANAME browser transport", () => {
  test("keeps API, events and media on the browser origin without exposing a token", () => {
    const transport = createTransport({ browser: true, origin: "http://localhost:4318", port: "9999", token: "must-not-leak" });
    expect(transport.base).toBe("/api");
    expect(transport.headers).toEqual({});
    expect(transport.url("/events")).toBe("http://localhost:4318/api/events");
    const media = new URL(transport.url("/files/preview?path=%2Ftmp%2Fa%20b.png"));
    expect(media.searchParams.get("path")).toBe("/tmp/a b.png");
    expect(media.searchParams.has("token")).toBe(false);
  });

  test("uses the browser host and TLS protocol for terminal sockets", () => {
    const secure = createTransport({ browser: true, origin: "https://kaname.example:8443", port: "4317", token: "ignored" });
    expect(secure.socketUrl("/terminals/one/ws")).toBe("wss://kaname.example:8443/api/terminals/one/ws");
    const local = createTransport({ browser: true, origin: "http://localhost:4318", port: "4317", token: "ignored" });
    expect(local.socketUrl("/terminals/one/ws")).toBe("ws://localhost:4318/api/terminals/one/ws");
  });

  test("preserves desktop loopback credentials, queries and sockets", () => {
    // The bundled views:// webview has an opaque ("null") origin.
    const transport = createTransport({ browser: false, origin: "null", port: "4319", token: "a&b+c" });
    expect(transport.base).toBe("http://127.0.0.1:4319");
    expect(transport.headers).toEqual({ authorization: "Bearer a&b+c" });
    const media = new URL(transport.url("/github/pull-blob?path=%2Ftmp%2Frepo&number=12"));
    expect(media.origin).toBe("http://127.0.0.1:4319");
    expect(media.searchParams.get("path")).toBe("/tmp/repo");
    expect(media.searchParams.get("number")).toBe("12");
    expect(media.searchParams.get("token")).toBe("a&b+c");
    expect(transport.socketUrl("/terminals/one/ws")).toBe("ws://127.0.0.1:4319/terminals/one/ws?token=a%26b%2Bc");
  });
});
