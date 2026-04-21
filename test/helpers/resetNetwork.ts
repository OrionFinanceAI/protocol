import { networkHelpers } from "./hh";

type SnapshotHandle = Awaited<ReturnType<typeof networkHelpers.takeSnapshot>>;

let fileBaseline: SnapshotHandle | undefined;

/** Restore prior snapshot (if any), then snapshot — isolates chain state between test files. For per-test isolation use `networkHelpers.loadFixture`. */
export async function resetNetwork(): Promise<void> {
  if (fileBaseline !== undefined) {
    await fileBaseline.restore();
  }
  fileBaseline = await networkHelpers.takeSnapshot();
}
