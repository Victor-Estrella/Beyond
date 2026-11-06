import type { Metadata } from "next";
import { SequencePlayer } from "@/components/sequence/SequencePlayer";

export const metadata: Metadata = {
  title: "BEYOND — Frame sequence",
  description: "The rendered journey, played back frame by frame under the scroll.",
};

/**
 * The pre-rendered journey as a scroll-driven frame sequence — the same
 * pictures the video is made of, without a live WebGL stage. Produced by
 * `npm run video`.
 */
export default function SequencePage() {
  return (
    <main>
      <SequencePlayer />
    </main>
  );
}
