import express from "express";
import axios from "axios";
import dotenv from "dotenv";
import multer from "multer";
import path from "path";
import fs from "fs";
import RSS from "rss";
import { fileURLToPath } from "url";
import { dirname } from "path";
import ffmpeg from "fluent-ffmpeg";
import ffmpegInstaller from "@ffmpeg-installer/ffmpeg";
import ffprobeInstaller from "@ffprobe-installer/ffprobe";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

dotenv.config();

ffmpeg.setFfmpegPath(ffmpegInstaller.path);
ffmpeg.setFfprobePath(ffprobeInstaller.path);

const app = express();
const port = process.env.PORT || 3000;

app.use(express.json());
app.use(express.static("public"));

const upload = multer({ dest: "uploads/" });

// Semaphore implementation for limiting concurrent operations
class Semaphore {
  private permits: number;
  private tasks: (() => void)[] = [];

  constructor(permits: number) {
    this.permits = permits;
  }

  acquire(): Promise<() => void> {
    return new Promise<() => void>((resolve) => {
      const task = () => {
        this.permits--;
        resolve(this.release.bind(this));
      };

      if (this.permits > 0) {
        task();
      } else {
        this.tasks.push(task);
      }
    });
  }

  private release(): void {
    this.permits++;
    if (this.tasks.length > 0 && this.permits > 0) {
      const nextTask = this.tasks.shift();
      if (nextTask) nextTask();
    }
  }
}

interface AudioFile {
  id: string;
  title: string;
  fileName: string;
  date: Date;
}

let audioFiles: AudioFile[] = [];
app.get("/", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "index.html"));
});

app.get("/podcast", (req, res) => {
  res.sendFile(path.join(__dirname, "..", "public", "podcast.html"));
});

app.get("/podcast-data", (req, res) => {
  res.json(audioFiles);
});

async function generateTitle(text: string): Promise<string> {
  try {
    const response = await axios.post(
      "https://api.openai.com/v1/chat/completions",
      {
        model: "gpt-3.5-turbo",
        messages: [
          {
            role: "system",
            content:
              "You are a helpful assistant that generates concise titles for text content.",
          },
          {
            role: "user",
            content: `Generate a concise title (5 words or less) for the following text:\n\n${text.substring(0, 1000)}...`,
          },
        ],
        max_tokens: 20,
      },
      {
        headers: {
          Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
          "Content-Type": "application/json",
        },
      },
    );

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    console.error("Error generating title:", error);
    return "Untitled";
  }
}

app.post("/convert", upload.none(), async (req, res) => {
  res.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });

  const sendProgress = (status: string, progress: number) => {
    res.write(`data: ${JSON.stringify({ status, progress })}\n\n`);
  };

  try {
    const { text } = req.body;

    sendProgress("Generating title", 0);
    const title = await generateTitle(text);
    sendProgress("Title generated", 10);

    const fileName = `speech_${Date.now()}.mp3`;
    const filePath = path.join(__dirname, "..", "public", fileName);

    await textToSpeech(text, filePath, sendProgress);

    const id = Date.now().toString();
    audioFiles.push({ id, title, fileName, date: new Date() });

    res.write(
      `data: ${JSON.stringify({ success: true, fileName, title })}\n\n`,
    );
  } catch (error) {
    console.error("Error:", error);
    res.write(
      `data: ${JSON.stringify({ success: false, error: "An error occurred during conversion" })}\n\n`,
    );
  } finally {
    res.end();
  }
});

async function textToSpeech(
  text: string,
  outputPath: string,
  sendProgress: (status: string, progress: number) => void,
): Promise<void> {
  const MAX_CHARS = 4000;
  const chunks = [];

  for (let i = 0; i < text.length; i += MAX_CHARS) {
    chunks.push(text.slice(i, i + MAX_CHARS));
  }

  const tempFiles: string[] = [];
  console.log("generating " + chunks.length + " chunks");

  const semaphore = new Semaphore(1); // Limit concurrent API calls

  const generateChunk = async (chunk: string, index: number) => {
    const release = await semaphore.acquire();
    try {
      sendProgress(
        `Generating chunk ${index + 1}/${chunks.length}`,
        10 + (index / chunks.length) * 70,
      );
      const response = await axios.post(
        "https://api.openai.com/v1/audio/speech",
        {
          model: "tts-1",
          input: chunk,
          voice: "fable",
        },
        {
          headers: {
            Authorization: `Bearer ${process.env.OPENAI_API_KEY}`,
            "Content-Type": "application/json",
          },
          responseType: "arraybuffer",
        },
      );

      const tempFilePath = path.join(
        __dirname,
        "..",
        "public",
        `temp_${index}.mp3`,
      );
      fs.writeFileSync(tempFilePath, response.data);
      console.log("chunk " + index + " added!");
      return tempFilePath;
    } finally {
      release();
    }
  };

  // Generate all chunks concurrently
  const chunkPromises = chunks.map((chunk, index) =>
    generateChunk(chunk, index),
  );
  tempFiles.push(...(await Promise.all(chunkPromises)));

  sendProgress("Merging audio files", 80);

  // Concatenate MP3 files using fluent-ffmpeg
  await new Promise<void>((resolve, reject) => {
    const command = ffmpeg();
    tempFiles.forEach((file) => {
      command.input(file);
    });
    command
      .on("error", (err) => {
        console.error("An error occurred: " + err.message);
        reject(err);
      })
      .on("end", () => {
        console.log("Merging finished !");
        resolve();
      })
      .mergeToFile(outputPath, path.dirname(outputPath));
  });

  sendProgress("Cleaning up temporary files", 90);

  // Clean up temp files
  tempFiles.forEach((file) => fs.unlinkSync(file));

  sendProgress("Conversion complete", 100);
}

app.delete("/delete/:id", (req, res) => {
  const { id } = req.params;
  const index = audioFiles.findIndex((file) => file.id === id);

  if (index === -1) {
    return res.status(404).json({ success: false, error: "File not found" });
  }

  const file = audioFiles[index];
  const filePath = path.join(__dirname, "..", "public", file.fileName);

  // Remove file from filesystem
  fs.unlink(filePath, (err) => {
    if (err) {
      console.error("Error deleting file:", err);
      return res
        .status(500)
        .json({ success: false, error: "Error deleting file" });
    }

    // Remove file from audioFiles array
    audioFiles.splice(index, 1);
    res.json({ success: true });
  });
});

app.get("/feed", (req, res) => {
  const feed = new RSS({
    title: "My Text-to-Speech Podcast",
    description: "A podcast of converted text-to-speech audio files",
    feed_url: `${req.protocol}://${req.get("host")}/feed`,
    site_url: `${req.protocol}://${req.get("host")}`,
  });

  audioFiles.forEach((file) => {
    feed.item({
      title: file.title,
      description: file.title,
      url: `${req.protocol}://${req.get("host")}/${file.fileName}`,
      date: file.date,
      enclosure: {
        url: `${req.protocol}://${req.get("host")}/${file.fileName}`,
        type: "audio/mpeg",
      },
    });
  });

  res.set("Content-Type", "application/rss+xml");
  res.send(feed.xml());
});

app.listen(port, () => {
  console.log(`Server is running on port ${port}`);
});
