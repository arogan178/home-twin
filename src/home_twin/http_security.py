"""Validate HTTP hosts and browser write origins before reading request bodies."""

from urllib.parse import urlsplit

from starlette.datastructures import Headers
from starlette.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

DEV_ORIGINS = ("http://127.0.0.1:5173", "http://localhost:5173")
LOOPBACK_HOSTS = ("127.0.0.1", "localhost", "::1")
WILDCARD_HOSTS = frozenset({"0.0.0.0", "::"})


class BrowserRequests:
    def __init__(self, app: ASGIApp, allowed_hosts: tuple[str, ...]) -> None:
        self.app = app
        self.allowed_hosts = frozenset(host.lower().strip("[]") for host in allowed_hosts)

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] == "http":
            headers = Headers(scope=scope)
            authority = headers.get("host", "")
            try:
                parsed = urlsplit("//" + authority)
                hostname = parsed.hostname
                _ = parsed.port
            except ValueError:
                hostname = None
            if hostname not in self.allowed_hosts or any(char in authority for char in "/\\?#@ \t\r\n"):
                response = JSONResponse(
                    {"detail": {"code": "untrusted_host", "message": "The request host is not allowed."}},
                    status_code=400,
                )
                await response(scope, receive, send)
                return

        if scope["type"] == "http" and scope["method"] not in {"GET", "HEAD", "OPTIONS"}:
            origin = headers.get("origin")
            own_origin = f"{scope['scheme']}://{authority}"
            if origin is not None and origin not in (*DEV_ORIGINS, own_origin):
                response = JSONResponse(
                    {"detail": {"code": "untrusted_origin", "message": "Browser writes must come from Home Twin."}},
                    status_code=403,
                )
                await response(scope, receive, send)
                return
        await self.app(scope, receive, send)


class _BodyTooLarge(Exception):
    pass


class BodyLimits:
    """Cut a request body off at a per-path byte limit while it streams in.

    ``limits`` maps a request path to its largest accepted body and the 413 message.
    """

    def __init__(self, app: ASGIApp, limits: dict[str, tuple[int, str]]) -> None:
        self.app = app
        self.limits = limits

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        limit = self.limits.get(scope["path"]) if scope["type"] == "http" else None
        if limit is None:
            await self.app(scope, receive, send)
            return
        max_bytes, message = limit
        too_large = JSONResponse({"detail": message}, status_code=413)
        declared = Headers(scope=scope).get("content-length")
        if declared is not None and (not declared.isdigit() or int(declared) > max_bytes):
            await too_large(scope, receive, send)
            return

        received = 0
        exceeded = False
        response_started = False

        async def limited_receive() -> Message:
            nonlocal received, exceeded
            if exceeded:
                raise _BodyTooLarge
            message = await receive()
            if message["type"] == "http.request":
                received += len(message.get("body", b""))
                if received > max_bytes:
                    exceeded = True
                    raise _BodyTooLarge
            return message

        async def guarded_send(message: Message) -> None:
            nonlocal response_started
            if exceeded:
                return
            response_started = True
            await send(message)

        try:
            await self.app(scope, limited_receive, guarded_send)
        except Exception:
            if not exceeded:
                raise
        if exceeded and not response_started:
            await too_large(scope, receive, send)
