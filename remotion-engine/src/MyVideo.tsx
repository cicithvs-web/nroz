import { useCurrentFrame, interpolate, spring, useVideoConfig } from "remotion";
import React from "react";

export const MyVideo: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const scale = spring({
    frame,
    fps,
    config: { damping: 12 },
  });

  const opacity = interpolate(frame, [0, 20], [0, 1], {
    extrapolateRight: "clamp",
  });

  return (
    <div
      style={{
        flex: 1,
        backgroundColor: "#0f172a",
        display: "flex",
        flexDirection: "column",
        justifyContent: "center",
        alignItems: "center",
        fontFamily: "sans-serif",
      }}
    >
      <div
        style={{
          transform: `scale(${scale})`,
          opacity,
          textAlign: "center",
          color: "#ffffff",
          padding: 40,
        }}
      >
        <h1 style={{ fontSize: 80, margin: 0, color: "#38bdf8" }}>
          Nroz AI Video 🎬
        </h1>
        <p style={{ fontSize: 40, color: "#94a3b8", marginTop: 20 }}>
          Dibuat dengan Remotion & React
        </p>
      </div>
    </div>
  );
};
