import { Hono } from "hono";

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
      throw new Error("Screenshot image is too large (>4MB) for OpenAI editing");
    }

    // Save screenshot to R2 bucket
    await c.env.OG_IMAGES_BUCKET.put(screenshotKey, screenshotBuffer, {
      httpMetadata: {
        contentType: "image/png",
      },
    });

    // Generate AI-enhanced OG image using OpenAI API directly with fetch
    const formData = new FormData();
    const imageBlob = new Blob([screenshotBuffer], { type: "image/png" });
    formData.append("image", imageBlob, "screenshot.png");
    formData.append("prompt", `Transform this website screenshot into a simplified Open Graph image. Show the site name clearly at the top, followed by one short tagline or key metric in bold text. Keep the composition minimal, clean, and mobile-friendly with plenty of white space. Add only one small playful icon or chart line, drawn in a child-like pencil sketch style on textured Canson paper. Ensure the text is large, sharp, and fully readable. Style it as a professional social media preview.`);
    formData.append("size", "1024x1024");
    formData.append("n", "1");
    formData.append("response_format", "url");

    const openaiResponse = await fetch("https://api.openai.com/v1/images/edits", {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${c.env.OPENAI_API_KEY}`,
      },
      body: formData,
    });

    if (!openaiResponse.ok) {
      const errorText = await openaiResponse.text();
      throw new Error(`OpenAI API failed: ${openaiResponse.status} - ${errorText}`);
    }

    const openaiData = await openaiResponse.json();

    if (!openaiData.data?.[0]?.url) {
      throw new Error("OpenAI did not return an image URL");
    }

    // Fetch the AI-generated image
    const ogImageResponse = await fetch(openaiData.data[0].url);

    if (!ogImageResponse.ok) {
      throw new Error(`Failed to fetch AI image: ${ogImageResponse.status}`);
    }

    const ogImageBuffer = await ogImageResponse.arrayBuffer();

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
