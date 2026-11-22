// Types for linear-time.mjs, so each package's type check reads the shared guard without including scripts/.

export interface LinearStep<S> {
  size: S;
  half: S;
  /** The fastest sample at `size` and at `half`, in ms. */
  took: number;
  previous: number;
  ratio: number;
  samples: number[];
  halfSamples: number[];
}

export function doubling(from: number, to: number): number[];

export function expectLinearTime<S>(options: {
  /** Named in a failure: which input this is. */
  shape: string;
  /** Ascending; the first is the first reference, not compared itself. */
  sizes: readonly S[];
  /** One run at `size`, returning its cost in ms. */
  measure: (size: S) => number | Promise<number>;
  slack: number;
  samples?: number;
  warmup?: readonly S[];
}): Promise<LinearStep<S>[]>;
