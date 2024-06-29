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
async function textToSpeech(text: string, outputPath: string): Promise<void> {
  const MAX_CHARS = 4000;
  const chunks = [];

  for (let i = 0; i < text.length; i += MAX_CHARS) {
    chunks.push(text.slice(i, i + MAX_CHARS));
  }

  const tempFiles : string[] = [];
  console.log('generating ' + chunks.length + ' chunks');

  const generateChunk = async (chunk: string, index: number) => {
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

    const tempFilePath = path.join(__dirname, "..", "public", `temp_${index}.mp3`);
    fs.writeFileSync(tempFilePath, response.data);
    console.log('chunk ' + index + ' added!');
    return tempFilePath;
  };

  // Generate all chunks concurrently
  const chunkPromises = chunks.map((chunk, index) => generateChunk(chunk, index));
  tempFiles.push(...await Promise.all(chunkPromises));

  // Concatenate MP3 files using fluent-ffmpeg
  await new Promise<void>((resolve, reject) => {
    console.log('Merging !');
    const command = ffmpeg();
    tempFiles.forEach(file => {
      command.input(file);
    });
    command
      .on('error', (err) => {
        console.error('An error occurred: ' + err.message);
        reject(err);
      })
      .on('end', () => {
        console.log('Merging finished !');
        resolve();
      })
      .mergeToFile(outputPath, path.dirname(outputPath));
  });

  // Clean up temp files
  tempFiles.forEach((file) => fs.unlinkSync(file));
}

app.post("/convert", upload.none(), async (req, res) => {
  try {
    const { text } = req.body;

    // Generate title
    const title = await generateTitle(text);

    const fileName = `speech_${Date.now()}.mp3`;
    const filePath = path.join(__dirname, "..", "public", fileName);

    await textToSpeech(text, filePath);
    
    const id = Date.now().toString(); // Simple unique ID
    audioFiles.push({ id, title, fileName, date: new Date() });

    res.json({ success: true, fileName, title });
  } catch (error) {
    console.error("Error:", error);
    res
      .status(500)
      .json({ success: false, error: "An error occurred during conversion" });
  }
});

app.delete("/delete/:id", (req, res) => {
  const { id } = req.params;
  const index = audioFiles.findIndex(file => file.id === id);

  if (index === -1) {
    return res.status(404).json({ success: false, error: "File not found" });
  }

  const file = audioFiles[index];
  const filePath = path.join(__dirname, "..", "public", file.fileName);

  // Remove file from filesystem
  fs.unlink(filePath, (err) => {
    if (err) {
      console.error("Error deleting file:", err);
      return res.status(500).json({ success: false, error: "Error deleting file" });
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