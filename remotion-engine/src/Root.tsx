import { registerRoot, Composition } from "remotion";
import React from "react";
import { MyVideo } from "./MyVideo";

export const RemotionRoot: React.FC = () => {
  return (
    <Composition
      id="MyVideo"
      component={MyVideo}
      durationInFrames={60}
      fps={30}
      width={1080}
      height={1920}
    />
  );
};

registerRoot(RemotionRoot);
