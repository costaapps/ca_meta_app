"""Small scoped GitHub API client. Credentials are never returned or logged."""
import json
import os
import time
import urllib.error
import urllib.request

REPOSITORY = "costaapps/ca_meta_app"


class ApiError(RuntimeError):
    pass


class GitHub:
    def __init__(self, token=None, write_interval=1.25):
        self.token = token or os.environ.get("GH_TOKEN")
        if not self.token:
            raise ApiError("GH_TOKEN is required for authenticated operations; never paste it into an issue")
        if os.environ.get("GITHUB_REPOSITORY", REPOSITORY) != REPOSITORY:
            raise ApiError("Repository mismatch; refusing cross-repository operations")
        self.write_interval = write_interval
        self.last_write = 0.0

    def request(self, method, path, data=None):
        if not path.startswith("/") or path.startswith("//"):
            raise ApiError("Only relative GitHub API paths are allowed")
        for attempt in range(4):
            if method != "GET":
                delay = self.write_interval - (time.monotonic() - self.last_write)
                if delay > 0:
                    time.sleep(delay)
                self.last_write = time.monotonic()
            req = urllib.request.Request(
                "https://api.github.com" + path,
                data=None if data is None else json.dumps(data).encode(),
                method=method,
                headers={"Authorization": "Bearer " + self.token,
                         "Accept": "application/vnd.github+json",
                         "Content-Type": "application/json",
                         "X-GitHub-Api-Version": "2026-03-10"},
            )
            try:
                with urllib.request.urlopen(req, timeout=30) as response:
                    raw = response.read()
                    return json.loads(raw) if raw else None
            except urllib.error.HTTPError as exc:
                # Never print the request, headers or credential. Respect rate limits.
                if exc.code in (403, 429) and exc.headers.get("Retry-After") and attempt < 3:
                    delay = max(1, int(exc.headers["Retry-After"]))
                    if delay > 60:
                        raise ApiError(f"Rate limit requires {delay}s before a later rerun; no early retry") from None
                    time.sleep(delay)
                    continue
                raise ApiError(f"GitHub HTTP {exc.code} for {method} {path.split('?')[0]}; no credential data logged") from None
            except (urllib.error.URLError, TimeoutError):
                # A write may have succeeded. Re-run with fresh reads, not blind retry.
                raise ApiError(f"Network outcome unknown for {method} {path.split('?')[0]}; inspect state before rerun") from None
        raise ApiError("Rate limit retry budget exhausted")

    def pages(self, path):
        result = []
        for page in range(1, 101):
            batch = self.request("GET", path + ("&" if "?" in path else "?") + f"per_page=100&page={page}")
            if not isinstance(batch, list):
                raise ApiError("Expected a paginated list")
            result.extend(batch)
            if len(batch) < 100:
                return result
        raise ApiError("Pagination safety limit reached")

    def graphql(self, query, variables=None):
        data = self.request("POST", "/graphql", {"query": query, "variables": variables or {}})
        if data.get("errors"):
            kinds = sorted({x.get("type", "GRAPHQL_ERROR") for x in data["errors"]})
            raise ApiError("GraphQL request failed: " + ", ".join(kinds))
        return data["data"]
