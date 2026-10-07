import React from "react";
import { Composition } from "remotion";
import { FPS, H, TOTAL_FRAMES, W } from "../lib/geometry";
import type { ReelProps } from "./context";
import { Reel } from "./Reel";

export const RemotionRoot: React.FC = () => (
  <Composition
    id="Reel"
    component={Reel as unknown as React.FC<Record<string, unknown>>}
    durationInFrames={TOTAL_FRAMES}
    fps={FPS}
    width={W}
    height={H}
    defaultProps={{} as unknown as Record<string, unknown> & ReelProps}
  />
);
