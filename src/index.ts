import { Hono } from "hono";
import { fal } from "@fal-ai/client";

const app = new Hono<{ Bindings: CloudflareBindings }>();

app.get("/", (c) => {
  return c.text(`
    <html>
      <body>
        <h1>OG Image Generator</h1>
      </body>
    </html>
  `);
});

app.get("/api/image", async (c) => {
  const site = c.req.query("site");

  if (!site) {
    return c.json({ error: "Site parameter is required" }, 400);
  }

  try {
    // Configure FAL with credentials
    fal.config({ credentials: c.env.FAL_KEY });

    // Create keys for both images
    const ogImageKey = `og-${encodeURIComponent(site)}.png`;
    const screenshotKey = `screenshot-${encodeURIComponent(site)}.png`;

    // Check if OG image already exists in R2 bucket
    const existingOGImage = await c.env.OG_IMAGES_BUCKET.get(ogImageKey);

    if (existingOGImage) {
      // Return existing OG image
      return new Response(existingOGImage.body, {
        headers: {
          "Content-Type": "image/png",
          "Cache-Control": "public, max-age=86400", // 24 hours
        },
      });
    }

    // Generate screenshot using Screenshot API with PNG format
    const screenshotUrl = `https://api.screenshotapi.com/take?url=${encodeURIComponent(
      site
    )}&apiKey=${c.env.SCREENSHOT_API_KEY}&format=png&width=1024&height=768`;
    const screenshotResponse = await fetch(screenshotUrl);

    if (!screenshotResponse.ok) {
      throw new Error(`Screenshot API failed: ${screenshotResponse.status}`);
    }

    const data: { outputUrl: string } = await screenshotResponse.json();

    if (!data.outputUrl) {
      throw new Error("Screenshot API did not return an image URL");
    }

    // Fetch the screenshot image
    const imageResponse = await fetch(data.outputUrl);

    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch screenshot: ${imageResponse.status}`);
    }

    const screenshotBuffer = await imageResponse.arrayBuffer();

    // Check if image is less than 4MB
    if (screenshotBuffer.byteLength > 4 * 1024 * 1024) {
      throw new Error(
        "Screenshot image is too large (>4MB) for OpenAI editing"
      );
    }

    // Save screenshot to R2 bucket
    await c.env.OG_IMAGES_BUCKET.put(screenshotKey, screenshotBuffer, {
      httpMetadata: {
        contentType: "image/png",
      },
    });

    // Convert screenshot buffer to data URL for FAL
    const base64Screenshot = btoa(
      String.fromCharCode(...new Uint8Array(screenshotBuffer))
    );
    const imageDataUrl = `data:image/png;base64,${base64Screenshot}`;

    // Use Recraft v3 image-to-image for optimal text and sketch conversion
    const falResult = await fal.subscribe("fal-ai/recraft/v3/image-to-image", {
      input: {
        prompt: `Transform this website screenshot into a hand-drawn sketch on textured Canson paper. Convert all text into handwritten style, make UI elements look like simple pencil drawings, preserve readable typography but in sketch form, childish drawing aesthetic`,
        image_url: imageDataUrl,
        sync_mode: true,
      },
    });

    if (!falResult.data?.images?.[0]?.url) {
      throw new Error("FAL AI did not return image URL");
    }

    // Fetch the edited image from FAL's URL
    const editedImageResponse = await fetch(falResult.data.images[0].url);

    if (!editedImageResponse.ok) {
      throw new Error(
        `Failed to fetch edited image: ${editedImageResponse.status}`
      );
    }

    const ogImageBuffer = await editedImageResponse.arrayBuffer();

    // Save AI-generated OG image to R2 bucket
    await c.env.OG_IMAGES_BUCKET.put(ogImageKey, ogImageBuffer, {
      httpMetadata: {
        contentType: "image/png",
      },
    });

    // Return the AI-generated OG image
    return new Response(ogImageBuffer, {
      headers: {
        "Content-Type": "image/png",
        "Cache-Control": "public, max-age=86400", // 24 hours
      },
    });
  } catch (error) {
    console.error("Error generating OG image:", error);
    return c.json(
      {
        error: "Failed to generate image",
        details: error instanceof Error ? error.message : "Unknown error",
      },
      500
    );
  }
});

export default app;
