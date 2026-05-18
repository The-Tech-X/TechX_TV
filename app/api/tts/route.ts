import { NextResponse } from 'next/server';
import { EdgeTTS } from '@seepine/edge-tts';
import { createClient } from '@supabase/supabase-js';

// Long scripts (10+ minutes of audio) can take a while to synthesize over the
// Edge TTS websocket — let the route run up to 5 minutes before Next.js kills it.
export const maxDuration = 300;
export const runtime = 'nodejs';

const TTS_TIMEOUT_MS = 5 * 60 * 1000; // 5 min — matches maxDuration above.

const supabase = createClient(
  process.env.NEXT_PUBLIC_SUPABASE_URL || '',
  process.env.SUPABASE_SERVICE_ROLE_KEY || ''
);

export async function POST(req: Request) {
  try {
    const { text, episodeId } = await req.json();

    if (!text || !episodeId) {
      return NextResponse.json({ error: 'Text and episodeId are required' }, { status: 400 });
    }

    // Strip any residual markdown or symbols that would sound bad when spoken
    const cleanText = text
      .replace(/[#*`_~\[\]]/g, '')           // markdown syntax
      .replace(/---+/g, '')                   // horizontal rules
      .replace(/\*\*(.*?)\*\*/g, '$1')        // bold
      .replace(/\*(.*?)\*/g, '$1')            // italic
      .replace(/\n{3,}/g, '\n\n')             // excessive blank lines
      .trim();

    // en-US-AndrewNeural: warm, natural, conversational — best for long-form podcast audio.
    // Default lib timeout is 60s which dies on 5-10 min scripts; bump to TTS_TIMEOUT_MS.
    const tts = new EdgeTTS({
      voice: 'en-US-AndrewNeural',
      timeout: TTS_TIMEOUT_MS,
    });

    const res = await tts.call(cleanText);
    const audioBuffer = res.data;

    const fileName = `episode-${episodeId}-${Date.now()}.mp3`;

    // Upload to Supabase Storage
    const { data: uploadData, error: uploadError } = await supabase
      .storage
      .from('audio')
      .upload(fileName, audioBuffer, {
        contentType: 'audio/mpeg',
        upsert: true
      });

    if (uploadError) {
      console.error('Storage Upload Error:', uploadError);
      return NextResponse.json({ error: 'Failed to upload audio to Supabase. Ensure you have an "audio" bucket created.' }, { status: 500 });
    }

    // Get public URL
    const { data: publicUrlData } = supabase
      .storage
      .from('audio')
      .getPublicUrl(fileName);

    const audioUrl = publicUrlData.publicUrl;

    // Update database record to attach the audio
    await supabase
      .from('episodes')
      .update({ audio_url: audioUrl })
      .eq('id', episodeId);

    return NextResponse.json({ success: true, audio_url: audioUrl });

  } catch (error: any) {
    console.error('TTS API Error:', error);
    return NextResponse.json({ error: error.message || 'Failed to generate audio' }, { status: 500 });
  }
}
