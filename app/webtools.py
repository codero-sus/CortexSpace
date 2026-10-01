"""Web search + page fetching.

Search backends (in order):
  1. SearXNG instance if configured (JSON API) — same as Odysseus, self-hosted.
  2. DuckDuckGo HTML endpoint (no key required).

Both fail gracefully when offline — the agent gets a clear message instead of a crash.
"""
from __future__ import annotations

import asyncio
import ipaddress
import re
import socket
import urllib.parse

import httpx

UA = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/126.0 Safari/537.36 MyWorkspaceAI/1.0"
)

_timeout = httpx.Timeout(12.0, connect=6.0)


async def _http_get(url: str, headers: dict | None = None, follow: bool = True) -> httpx.Response:
    async with httpx.AsyncClient(timeout=_timeout, follow_redirects=follow, headers=headers or {}) as client:
        return await client.get(url)


# --------------------------------------------------------------------------
# Search
# --------------------------------------------------------------------------

def _parse_ddg_html(html: str) -> list[dict]:
    results = []
    # Each result sits in <div class="result ..."> with <a class="result__a" href="...">
    for m in re.finditer(
        r'<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>(.*?)</a>.*?'
        r'(?:<a[^>]+class="result__snippet"[^>]*>(.*?)</a>)?',
        html,
        re.S,
    ):
        href, title, snippet = m.group(1), m.group(2), m.group(3) or ""
        href = _ddg_unwrap(href)
        title = re.sub(r"<[^>]+>", "", title).strip()
        snippet = re.sub(r"<[^>]+>", "", snippet).strip()
        if href.startswith("http") and title:
            results.append({"title": title, "url": href, "snippet": snippet})
        if len(results) >= 8:
            break
    return results


def _ddg_unwrap(href: str) -> str:
    # DDG wraps links like //duckduckgo.com/l/?uddg=<encoded>
    if "uddg=" in href:
        q = urllib.parse.urlparse(href).query
        for pair in q.split("&"):
            if pair.startswith("uddg="):
                return urllib.parse.unquote(pair[5:])
    if href.startswith("//"):
        return "https:" + href
    return href


async def ddg_search(query: str, max_results: int = 8) -> list[dict]:
    url = "https://html.duckduckgo.com/html/?q=" + urllib.parse.quote(query)
    resp = await _http_get(url, headers={"User-Agent": UA})
    resp.raise_for_status()
    return _parse_ddg_html(resp.text)[:max_results]


async def searxng_search(base_url: str, query: str, max_results: int = 8) -> list[dict]:
    base = base_url.rstrip("/")
    url = f"{base}/search?q={urllib.parse.quote(query)}&format=json"
    resp = await _http_get(url, headers={"User-Agent": UA})
    resp.raise_for_status()
    data = resp.json()
    out = []
    for r in data.get("results", [])[:max_results]:
        out.append(
            {
                "title": r.get("title", ""),
                "url": r.get("url", ""),
                "snippet": re.sub(r"<[^>]+>", "", r.get("content", "")).strip(),
            }
        )
    return out


async def web_search(query: str, searxng_url: str = "", ddg_enabled: bool = True, max_results: int = 8) -> dict:
    """Returns {"query":..., "results":[...]} or raises RuntimeError with a friendly message."""
    errors = []
    if searxng_url:
        try:
            res = await searxng_search(searxng_url, query, max_results)
            if res:
                return {"query": query, "engine": "searxng", "results": res}
        except Exception as e:  # noqa: BLE001
            errors.append(f"searxng: {type(e).__name__}")
    if ddg_enabled:
        try:
            res = await ddg_search(query, max_results)
            if res:
                return {"query": query, "engine": "duckduckgo", "results": res}
        except Exception as e:  # noqa: BLE001
            errors.append(f"duckduckgo: {type(e).__name__}")
    raise RuntimeError(
        "Web search unavailable right now (" + ", ".join(errors) + "). "
        "This host may be offline, or a search backend (SearXNG) needs to be configured in Settings."
    )


# --------------------------------------------------------------------------
# Page fetching with SSRF guard
# --------------------------------------------------------------------------

_BLOCKED_NETS = []
for _cidr in ("10.0.0.0/8", "172.16.0.0/12", "192.168.0.0/16", "127.0.0.0/8",
              "169.254.0.0/16", "0.0.0.0/8", "::1/128", "fc00::/7", "fe80::/10"):
    _BLOCKED_NETS.append(ipaddress.ip_network(_cidr))


def _assert_public_host(hostname: str) -> None:
    if hostname in ("localhost",):
        raise RuntimeError(f"Blocked: {hostname} is not an allowed public host")
    try:
        infos = socket.getaddrinfo(hostname, None)
    except socket.gaierror as e:
        raise RuntimeError(f"DNS lookup failed for {hostname}: {e}") from e
    for info in infos:
        ip = ipaddress.ip_address(info[4][0])
        if any(ip in net for net in _BLOCKED_NETS):
            raise RuntimeError(f"Blocked: {hostname} resolves to a private/internal address")


def html_to_text(html: str, max_chars: int = 24_000) -> str:
    html = re.sub(r"(?is)<(script|style|noscript|svg|head)[^>]*>.*?</\1>", " ", html)
    html = re.sub(r"(?i)<br\s*/?>", "\n", html)
    html = re.sub(r"(?i)</(p|div|section|article|li|tr|h[1-6]|blockquote)>", "\n", html)
    text = re.sub(r"(?s)<[^>]+>", " ", html)
    text = (
        text.replace("&nbsp;", " ")
        .replace("&amp;", "&")
        .replace("&lt;", "<")
        .replace("&gt;", ">")
        .replace("&quot;", '"')
        .replace("&#x27;", "'")
        .replace("&apos;", "'")
    )
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()[:max_chars]


async def fetch_page(url: str, max_chars: int = 24_000) -> dict:
    parsed = urllib.parse.urlparse(url)
    if parsed.scheme not in ("http", "https"):
        raise RuntimeError(f"Unsupported URL scheme: {parsed.scheme!r}")
    if not parsed.hostname:
        raise RuntimeError("URL has no hostname")
    await asyncio.to_thread(_assert_public_host, parsed.hostname)
    resp = await _http_get(url, headers={"User-Agent": UA})
    resp.raise_for_status()
    ctype = resp.headers.get("content-type", "")
    if "html" not in ctype and "text" not in ctype:
        raise RuntimeError(f"Unsupported content type: {ctype}")
    m = re.search(r"(?is)<title[^>]*>(.*?)</title>", resp.text)
    title = re.sub(r"<[^>]+>", "", m.group(1)).strip() if m else url
    text = html_to_text(resp.text, max_chars)
    return {"url": str(resp.url), "final_url": str(resp.url), "title": title, "text": text}
