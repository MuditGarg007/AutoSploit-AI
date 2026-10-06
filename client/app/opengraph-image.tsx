import { ImageResponse } from "next/og";

// Static social share card, generated at build time. True black, one burgundy
// accent, the type carrying the weight: the same restraint as the product UI.
// Shared as both the OpenGraph and Twitter image via the file-based metadata API.

export const alt = "AutoSploit AI: autonomous red-team";
export const size = { width: 1200, height: 630 };
export const contentType = "image/png";

export default function OpengraphImage() {
  return new ImageResponse(
    (
      <div
        style={{
          width: "100%",
          height: "100%",
          display: "flex",
          flexDirection: "column",
          justifyContent: "space-between",
          background: "#000000",
          padding: "80px",
          fontFamily: "sans-serif",
        }}
      >
        <div
          style={{
            display: "flex",
            fontSize: 26,
            letterSpacing: 6,
            textTransform: "uppercase",
            color: "#a8283a",
          }}
        >
          Autonomous red-team
        </div>

        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <div
            style={{
              display: "flex",
              fontSize: 88,
              fontWeight: 600,
              letterSpacing: -2,
              lineHeight: 1.05,
              color: "#ffffff",
            }}
          >
            Break in before they do.
          </div>
          <div
            style={{
              display: "flex",
              fontSize: 34,
              color: "#a1a1aa",
              maxWidth: 820,
            }}
          >
            Isolated, disposable engagements. Real exploits, contained in a
            gVisor sandbox, torn down on exit.
          </div>
        </div>

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: 16,
            fontSize: 30,
            fontWeight: 600,
            color: "#ffffff",
          }}
        >
          <div style={{ display: "flex", width: 14, height: 44, background: "#8c1c2b" }} />
          AutoSploit AI
        </div>
      </div>
    ),
    size,
  );
}
