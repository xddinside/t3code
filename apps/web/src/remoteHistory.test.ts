import { describe, expect, it } from "vitest";

import { preserveRemoteAuthTokenInPath } from "./remoteHistory";

describe("remoteHistory", () => {
  it("preserves the remote auth token across in-app route changes", () => {
    expect(
      preserveRemoteAuthTokenInPath(
        "/thread-123",
        "?token=secret-token",
        "https://remote.example.com",
      ),
    ).toBe("/thread-123?token=secret-token");
  });

  it("merges the remote auth token with existing search params and hashes", () => {
    expect(
      preserveRemoteAuthTokenInPath(
        "/thread-123?diff=1#footer",
        "?token=secret-token",
        "https://remote.example.com",
      ),
    ).toBe("/thread-123?diff=1&token=secret-token#footer");
  });

  it("does not overwrite an explicit token in the destination path", () => {
    expect(
      preserveRemoteAuthTokenInPath(
        "/thread-123?token=explicit-token",
        "?token=secret-token",
        "https://remote.example.com",
      ),
    ).toBe("/thread-123?token=explicit-token");
  });

  it("leaves paths unchanged when the current page has no remote auth token", () => {
    expect(
      preserveRemoteAuthTokenInPath("/thread-123?diff=1", "", "https://remote.example.com"),
    ).toBe("/thread-123?diff=1");
  });

  it("does not append remote auth tokens to cross-origin links", () => {
    expect(
      preserveRemoteAuthTokenInPath(
        "https://docs.example.com/guide",
        "?token=secret-token",
        "https://remote.example.com",
      ),
    ).toBe("https://docs.example.com/guide");
  });
});
