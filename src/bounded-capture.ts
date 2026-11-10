// Bounded streaming capture that preserves both the beginning and the end.
//
// Build/test failures are commonly printed at the end of very chatty output. A
// first-N-bytes collector loses exactly the diagnostics an agent needs. This
// keeps a head and rolling tail within the same memory budget.
export class BoundedCapture {
  private readonly maxBytes: number;
  private readonly headLimit: number;
  private readonly tailLimit: number;
  private readonly head: Buffer[] = [];
  private headBytes = 0;
  private tail = Buffer.alloc(0);
  private totalBytes = 0;

  constructor(maxBytes: number) {
    this.maxBytes = Math.max(1024, Math.floor(maxBytes));
    this.headLimit = Math.floor(this.maxBytes / 2);
    this.tailLimit = this.maxBytes - this.headLimit;
  }

  push(buf: Buffer): void {
    if (!buf.length) return;
    this.totalBytes += buf.length;
    let rest = buf;

    if (this.headBytes < this.headLimit) {
      const take = Math.min(rest.length, this.headLimit - this.headBytes);
      if (take > 0) {
        this.head.push(rest.subarray(0, take));
        this.headBytes += take;
        rest = rest.subarray(take);
      }
    }

    if (!rest.length || this.tailLimit <= 0) return;
    if (rest.length >= this.tailLimit) {
      this.tail = Buffer.from(rest.subarray(rest.length - this.tailLimit));
      return;
    }
    if (this.tail.length + rest.length <= this.tailLimit) {
      this.tail = Buffer.concat([this.tail, rest]);
      return;
    }
    const keep = this.tailLimit - rest.length;
    this.tail = Buffer.concat([this.tail.subarray(Math.max(0, this.tail.length - keep)), rest]);
  }

  get truncated(): boolean {
    return this.totalBytes > this.maxBytes;
  }

  get text(): string {
    const head = Buffer.concat(this.head);
    if (!this.truncated) return Buffer.concat([head, this.tail]).toString("utf8");
    return (
      head.toString("utf8") +
      "\n...[middle output truncated; preserved head and tail]...\n" +
      this.tail.toString("utf8")
    );
  }

  get seenBytes(): number {
    return this.totalBytes;
  }
}
