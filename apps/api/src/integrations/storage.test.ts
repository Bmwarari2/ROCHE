import {
  DeleteObjectsCommand,
  type DeleteObjectsCommandOutput,
  ListObjectVersionsCommand,
  type ListObjectVersionsCommandOutput,
  type S3Client,
} from "@aws-sdk/client-s3";
import { describe, expect, it } from "vitest";
import { S3DocumentStorage, StorageDeleteFailed } from "./storage";

/**
 * The S3 adapter's deletion past retention (security review of #134, M2): DeleteObjects answers
 * 200 with per-object `Errors`, so a deletion counts only when no error came back and the key has
 * no version left. A double of the S3 client stands in for the bucket.
 */

const KEY =
  "tenants/0194d000-0000-7000-8000-000000000001/documents/0194d000-0000-7000-8600-0000000000aa";

interface Double {
  readonly client: S3Client;
  readonly deleted: string[][];
}

/** A bucket double: `listings` answers each ListObjectVersions in turn; `errors`, DeleteObjects. */
function bucket(
  listings: string[][],
  errors: NonNullable<DeleteObjectsCommandOutput["Errors"]> = [],
): Double {
  const deleted: string[][] = [];
  let listed = 0;
  const send = async (command: unknown) => {
    if (command instanceof ListObjectVersionsCommand) {
      const versions = listings[Math.min(listed, listings.length - 1)] ?? [];
      listed += 1;
      return {
        Versions: versions.map((VersionId) => ({ Key: KEY, VersionId })),
        // Another key under the same prefix is never touched.
        DeleteMarkers: [{ Key: `${KEY}-other`, VersionId: "other" }],
        IsTruncated: false,
      } satisfies Partial<ListObjectVersionsCommandOutput>;
    }
    if (command instanceof DeleteObjectsCommand) {
      deleted.push((command.input.Delete?.Objects ?? []).map((o) => o.VersionId ?? ""));
      return { Errors: errors } satisfies Partial<DeleteObjectsCommandOutput>;
    }
    throw new Error("Unexpected command");
  };
  return { client: { send } as unknown as S3Client, deleted };
}

describe("S3DocumentStorage.destroy (security review of #134, M2)", () => {
  it("deletes every version of the key and confirms none is left", async () => {
    const double = bucket([["v1", "v2"], []]);
    await expect(new S3DocumentStorage("docs", double.client).destroy(KEY)).resolves.toBe(
      undefined,
    );
    expect(double.deleted).toEqual([["v1", "v2"]]);
  });

  it("throws when the batch delete answers with errors, so the retry goes on", async () => {
    const double = bucket(
      [["v1", "v2"], []],
      [{ Key: KEY, VersionId: "v2", Code: "AccessDenied", Message: "Access Denied" }],
    );
    const failure = await new S3DocumentStorage("docs", double.client)
      .destroy(KEY)
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(StorageDeleteFailed);
    expect(failure).toMatchObject({ name: "StorageDeleteFailed", code: "AccessDenied", count: 1 });
    // Only S3's code is kept: never the key or the message.
    expect(JSON.stringify(failure)).not.toContain(KEY);
  });

  it("throws when a version is still listed after the delete", async () => {
    const double = bucket([["v1"], ["v1"]]);
    await expect(new S3DocumentStorage("docs", double.client).destroy(KEY)).rejects.toMatchObject({
      code: "VersionsRemain",
      count: 1,
    });
  });

  it("does nothing, and succeeds, when the key has no version left", async () => {
    const double = bucket([[], []]);
    await new S3DocumentStorage("docs", double.client).destroy(KEY);
    expect(double.deleted).toEqual([]);
  });
});
