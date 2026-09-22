# `@hypit/minimax-h3`

Exact author/compute contracts and package-owned author Surfaces for MiniMax H3 video generation.

Frame-guided and subject-reference modes are separate Surfaces rather than one dynamic
port mode. Each produces an ordinary video Artifact. This package owns request semantics
and validation only; Provider calls, credentials, retries and queueing belong to a Runtime Endpoint
selected in the Runtime Profile.

```xml
<h3:FrameVideo id="motion" prompt={motionPrompt} duration="6" resolution="2K"
  first-frame={cover.image} last-frame={ending.image}/>
<h3:ReferenceVideo id="speaker-take" prompt={speakerPrompt} duration="6" resolution="768P" aspect-ratio="9:16">
  <h3:Reference image={presenter.image}/>
  <h3:Reference audio={voice-sample}/>
</h3:ReferenceVideo>
```

The Surface makes every prompt/media dependency an explicit graph edge and leaves execution to a Provider.
`FrameVideo` accepts a first frame, a last frame, or both; either frame is an ordinary image Artifact edge.
`ReferenceVideo` requires both a reference image and reference audio.

Prompt Kits for recurring H3 semantics live in [`@hypit/minimax-h3-kits`](../minimax-h3-kits/README.md).
