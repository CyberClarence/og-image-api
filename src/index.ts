import { Hono } from "hono";
import OpenAI from "openai";

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
    // Initialize OpenAI client
    const openai = new OpenAI({
      apiKey: c.env.OPENAI_API_KEY,
    });

    // Create keys for both images
    const ogImageKey = `og-${encodeURIComponent(site)}.jpg`;
    const screenshotKey = `screenshot-${encodeURIComponent(site)}.jpg`;

    // Check if OG image already exists in R2 bucket
    const existingOGImage = await c.env.OG_IMAGES_BUCKET.get(ogImageKey);

    if (existingOGImage) {
      // Return existing OG image
      return new Response(existingOGImage.body, {
        headers: {
          "Content-Type": "image/jpeg",
          "Cache-Control": "public, max-age=86400", // 24 hours
        },
      });
    }

    // Generate screenshot using Screenshot API
    const screenshotUrl = `https://api.screenshotapi.com/take?url=${encodeURIComponent(
      site
    )}&apiKey=${process.env.SCREENSHOT_API_KEY}`;
    const screenshotResponse = await fetch(screenshotUrl);

    if (!screenshotResponse.ok) {
      throw new Error(`Screenshot API failed: ${screenshotResponse.status}`);
    }

    const data: { outputUrl: string } = await screenshotResponse.json();

    if (!data.outputUrl) {
      throw new Error("Screenshot API did not return an image URL");
    }

    // Fetch and store the screenshot
    const imageResponse = await fetch(data.outputUrl);

    if (!imageResponse.ok) {
      throw new Error(`Failed to fetch screenshot: ${imageResponse.status}`);
    }

    const screenshotBuffer = await imageResponse.arrayBuffer();

    // Save screenshot to R2 bucket
    await c.env.OG_IMAGES_BUCKET.put(screenshotKey, screenshotBuffer, {
      httpMetadata: {
        contentType: "image/jpeg",
      },
    });

    // Generate AI-enhanced OG image using OpenAI DALL-E 3
    // Note: Using generation instead of editing since OpenAI editing requires specific formats
    const openaiResponse = await openai.images.generate({
      prompt: `Create a simplified Open Graph image for the website "${site}". Show the site name clearly at the top, followed by one short tagline or key metric in bold text. Keep the composition minimal, clean, and mobile-friendly with plenty of white space. Add only one small playful icon or chart line, drawn in a child-like pencil sketch style on textured Canson paper. Ensure the text is large, sharp, and fully readable. Style it as a professional social media preview.`,
      size: "1024x1024",

      n: 1,
      response_format: "url",
    });

    if (!openaiResponse.data?.[0]?.url) {
      throw new Error("OpenAI did not return an image URL");
    }

    // Fetch the AI-generated image
    const ogImageResponse = await fetch(openaiResponse.data[0].url);

    if (!ogImageResponse.ok) {
      throw new Error(`Failed to fetch AI image: ${ogImageResponse.status}`);
    }

    const ogImageBuffer = await ogImageResponse.arrayBuffer();

    // Save AI-generated OG image to R2 bucket
    await c.env.OG_IMAGES_BUCKET.put(ogImageKey, ogImageBuffer, {
      httpMetadata: {
        contentType: "image/jpeg",
      },
    });

    // Return the AI-generated OG image
    return new Response(ogImageBuffer, {
      headers: {
        "Content-Type": "image/jpeg",
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
