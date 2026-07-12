import React, { useState, useEffect, useRef, useMemo } from 'react';
import { Capacitor } from '@capacitor/core';
import { motion, AnimatePresence } from 'motion/react';
import { 
  ArrowLeft, Trash2, Calendar, Tag, Camera,
  Plus, X, Bold, Italic, Underline, List,
  Strikethrough, Maximize2, Minimize2, Type, Heading2, Quote,
  ChevronUp, ChevronDown, Mic, MicOff, Pause, Play, Square, Sparkles,
  Clock, Edit
} from 'lucide-react';
import { AppSettings, Diary, Entry, EntryBlock, ResponsiveLayout } from '../types';
import RichTextEditor from './RichTextEditor';
import AudioWaveformPlayer from './AudioWaveformPlayer';
import SyncedImage from './SyncedImage';
import { audioService } from '../platform/audio';
import { persistMediaDataUri, persistOptimizedImageFile } from '../mobile/mediaStorage';
import { SyncConflictError } from '../sync/eventSyncEngine';
import { isNativePlatform } from '../platform';
import { VoiceRecorder } from '@independo/capacitor-voice-recorder';
import { SpeechRecognition as NativeSpeechRecognition } from '@capacitor-community/speech-recognition';
import { diaryRepository } from '../repositories';
import { getMoodsForSettings, getTagsForSettings } from '../domain/appSettings';
import { richTextHtmlToPlainText } from '../domain/richTextSanitizer';
import { measureAsync } from '../utils/performance';

interface EntryEditorScreenProps {
  diaries: Diary[];
  settings: AppSettings;
  diaryId?: string; // Optional default diary ID
  entryId?: string; // Optional entry ID if editing
  layout?: ResponsiveLayout;
  onBack: () => void;
  onRefreshEntries: () => void | Promise<void>;
  onFocusModeChange?: (active: boolean) => void;
  initialFocusMode?: boolean;
  initialDate?: string;
  initialPrompt?: string;
  onShowToast?: (message: string, type?: 'success' | 'info' | 'warning' | 'error') => void;
  onRunWithLoader?: (message: string, operation: () => Promise<void>, detail?: string) => Promise<void>;
  showDiarySelector?: boolean;
}

export default function EntryEditorScreen({
  diaries,
  settings,
  diaryId: initialDiaryId,
  entryId,
  layout = 'mobile',
  onBack,
  onRefreshEntries,
  onFocusModeChange,
  initialFocusMode = false,
  initialDate,
  initialPrompt,
  onShowToast,
  showDiarySelector = false
}: EntryEditorScreenProps) {
  // Find current entry if editing
  const isEditing = !!entryId;
  
  // State variables
  const [diaryId, setDiaryId] = useState<string>(initialDiaryId || diaries[0]?.id || 'diary-default');
  const [date, setDate] = useState<string>(initialDate || new Date().toISOString().split('T')[0]); // Default to today
  const [time, setTime] = useState<string>(() => {
    const now = new Date();
    return now.toTimeString().split(' ')[0].substring(0, 5); // Default to current time "HH:MM"
  });
  const [title, setTitle] = useState<string>('');
  const [body, setBody] = useState<string>('');
  const [blocks, setBlocks] = useState<EntryBlock[]>([]);
  const [activeBlockId, setActiveBlockId] = useState<string | null>(null);
  const [minimizedBlockIds, setMinimizedBlockIds] = useState<Set<string>>(new Set());
  const [currentTimeText, setCurrentTimeText] = useState<string>(() => {
    const now = new Date();
    return now.toTimeString().split(' ')[0].substring(0, 5); // "HH:MM"
  });
  
  const availableMoods = getMoodsForSettings(settings);
  const availableTags = getTagsForSettings(settings);

  const [mood, setMood] = useState(availableMoods[0] || { name: 'Joyful', emoji: '😊' });
  const [selectedTags, setSelectedTags] = useState<string[]>([]);
  const [photoUris, setPhotoUris] = useState<string[]>([]);
  const [showConfirmDelete, setShowConfirmDelete] = useState<boolean>(false);
  const [audioUri, setAudioUri] = useState<string | undefined>(undefined);
  const [isSaving, setIsSaving] = useState(false);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioChunksRef = useRef<Blob[]>([]);
  const [showTagPicker, setShowTagPicker] = useState<boolean>(false);
  const [fontFamily, setFontFamily] = useState<'serif' | 'sans' | 'mono'>('serif');
  const [isFocusMode, setIsFocusMode] = useState<boolean>(initialFocusMode);

  // Convert "HH:MM" to "HH:MM AM/PM"
  const formatTime12 = (time24?: string) => {
    if (!time24) return '';
    const [hourStr, minStr] = time24.split(':');
    const hour = parseInt(hourStr, 10);
    const ampm = hour >= 12 ? 'PM' : 'AM';
    const hour12 = hour % 12 || 12;
    return `${String(hour12).padStart(2, '0')}:${minStr} ${ampm}`;
  };
  
  // Privacy-first local reflection state. No text leaves the device.
  const [aiLoading, setAiLoading] = useState<boolean>(false);
  const [aiResult, setAiResult] = useState<{ reflection: string; tags: string[]; mood: string } | null>(null);
  const [aiError, setAiError] = useState<string>('');

  const handleAiEnhance = async () => {
    // Strip HTML formatting
    const plainText = richTextHtmlToPlainText([...blocks.map(block => block.body), body].join(' '));
    if (!plainText || plainText.length < 10) {
      setAiError('Please write at least a few sentences (at least 10 characters) before asking for reflection.');
      return;
    }
    setAiLoading(true);
    setAiError('');
    setAiResult(null);

    try {
      // Simulate a small, elegant processing delay to feel tactile and deep
      await new Promise(resolve => setTimeout(resolve, 850));

      const lowerText = plainText.toLowerCase();

      // Heuristic Mood Detection
      const moodKeywords: { [key: string]: string[] } = {
        Joyful: ["happy", "joy", "smile", "laugh", "wonderful", "great", "delighted", "love", "cheerful", "glad", "blessed", "good", "amazing", "pleasant", "sunny", "thrilled", "nice", "fun", "celebrate"],
        Calm: ["peace", "quiet", "calm", "relax", "silent", "gentle", "soft", "serene", "breathe", "still", "harmony", "rest", "cozy", "warm", "nature", "meditate", "slow", "ambient"],
        Sad: ["sad", "cry", "grief", "tear", "hurt", "blue", "unhappy", "lonely", "broken", "disappointed", "sorrow", "pain", "miss", "gloomy", "tears", "loss", "alone", "heavy"],
        Anxious: ["anxious", "worry", "stress", "nervous", "fear", "scared", "afraid", "panic", "tense", "overwhelm", "shaky", "unsettled", "scary", "doubt", "pressure", "jittery"],
        Excited: ["excited", "hype", "thrill", "awesome", "incredible", "energy", "enthusiastic", "victory", "celebrate", "cant wait", "can't wait", "pumping", "super"],
        Reflective: ["reflect", "think", "wonder", "ponder", "memory", "past", "journal", "write", "learn", "understand", "realize", "grow", "mindful", "future", "reason", "myself"],
        Tired: ["tired", "sleep", "exhausted", "fatigue", "drain", "burnout", "heavy", "slow", "lazy", "restless", "weary", "yawn", "sleepy", "asleep", "nap"],
        Creative: ["create", "paint", "draw", "write", "build", "design", "inspire", "art", "music", "project", "idea", "craft", "photo", "imagination", "sketch", "code", "novel"]
      };

      let detectedMood = 'Reflective';
      let maxMatches = 0;

      Object.entries(moodKeywords).forEach(([moodName, keywords]) => {
        let matches = 0;
        keywords.forEach(keyword => {
          const regex = new RegExp(`\\b${keyword}\\b`, 'g');
          const count = (lowerText.match(regex) || []).length;
          matches += count;
        });
        if (matches > maxMatches) {
          maxMatches = matches;
          detectedMood = moodName;
        }
      });

      // Heuristic Tag Detection
      const tagKeywords: { [key: string]: string[] } = {
        happy: ["happy", "joy", "smile", "laugh", "wonderful", "great", "glad", "blessed", "cheerful"],
        travel: ["travel", "trip", "flight", "osaka", "kyoto", "japan", "hotel", "explore", "vacation", "journey", "city", "train", "adventure", "road", "outdoor", "walk"],
        summer: ["summer", "hot", "sun", "beach", "pool", "june", "july", "august", "warm", "weather", "sunny", "shines"],
        family: ["family", "mom", "dad", "sister", "brother", "parent", "home", "cousin", "kid", "child", "son", "daughter", "wife", "husband", "relative", "grandma", "grandpa"],
        calm: ["calm", "peace", "relax", "meditate", "breathe", "quiet", "cozy", "harmony", "rest", "serene", "silent", "gentle"],
        dream: ["dream", "sleep", "night", "asleep", "wish", "future", "hope", "ambition", "desire", "goal"],
        reading: ["read", "book", "novel", "author", "chapter", "library", "page", "literature", "poem", "poetry", "essay"],
        errands: ["errand", "work", "chore", "grocery", "buy", "clean", "task", "job", "career", "office", "meeting"],
        quotes: ["quote", "saying", "wisdom", "heard", "phrase", "proverb", "verse"],
        ideas: ["idea", "thought", "creative", "brainstorm", "concept", "project", "plan", "future", "solution", "inspiration"],
        thoughts: ["think", "mind", "ponder", "wonder", "feeling", "feel", "reflection", "self", "realize", "reminisce"]
      };

      const suggestedTags: string[] = [];
      Object.entries(tagKeywords).forEach(([tagName, keywords]) => {
        let hasMatch = false;
        keywords.forEach(keyword => {
          if (lowerText.includes(keyword)) {
            hasMatch = true;
          }
        });
        if (hasMatch) {
          suggestedTags.push(tagName);
        }
      });

      // Always ensure 2-3 suggested tags
      if (suggestedTags.length < 2) {
        if (!suggestedTags.includes('thoughts')) suggestedTags.push('thoughts');
        if (!suggestedTags.includes('ideas')) suggestedTags.push('ideas');
      }

      // Empathy Reflections Map
      const reflections: { [key: string]: string } = {
        Joyful: "It's beautiful to see you celebrating this moment of joy! Savoring these happy experiences is a powerful way to build emotional resilience and lasting memories. Keep shining bright.",
        Calm: "You've captured a wonderfully peaceful state of mind. Pausing to appreciate quiet, cozy moments is a gentle gift to yourself. May this sense of serenity stay with you.",
        Sad: "I'm holding space for you as you process these heavy or sad feelings. It is completely okay not to be okay. Remember to be exceptionally kind and gentle with yourself right now.",
        Anxious: "It sounds like there's a lot on your mind, and things might feel overwhelming. Take a soft, deep breath. Focus on just this single present moment—you are safe here.",
        Excited: "Your excitement and vibrant energy are absolutely contagious! Harness this wonderful momentum to propel your dreams forward. Embrace the journey ahead.",
        Reflective: "Your deep reflection shows a beautiful level of self-awareness. Taking the time to look inward and ponder your path is how we grow. Your journey is uniquely yours.",
        Tired: "You seem to be carrying a heavy load and feeling depleted. Please give yourself permission to fully rest and recharge. You don't have to carry it all today.",
        Creative: "What an inspiring spark of creativity and imagination! Bringing new ideas or art into the world is a wonderful expression of who you are. Keep creating."
      };

      const reflectionText = reflections[detectedMood] || reflections.Reflective;

      setAiResult({
        reflection: reflectionText,
        tags: suggestedTags.slice(0, 4),
        mood: detectedMood
      });
    } catch (err: any) {
      setAiError('An error occurred during local reflection analysis.');
    } finally {
      setAiLoading(false);
    }
  };

  const applyAiMood = (moodName: string) => {
    const foundMood = availableMoods.find(m => m.name.toLowerCase() === moodName.toLowerCase());
    if (foundMood) {
      setMood(foundMood);
    } else {
      const standardEmojis: { [key: string]: string } = {
        joyful: '😊', calm: '😌', sad: '😢', anxious: '😟', excited: '🤩', reflective: '💭', tired: '😴', creative: '🎨'
      };
      const emoji = standardEmojis[moodName.toLowerCase()] || '📝';
      setMood({ name: moodName, emoji });
    }
  };

  const applyAiTag = (tag: string) => {
    const formattedTag = tag.trim().toLowerCase();
    if (formattedTag && !selectedTags.includes(formattedTag)) {
      setSelectedTags(prev => [...prev, formattedTag]);
    }
  };
  const [isDockMinimized, setIsDockMinimized] = useState<boolean>(initialFocusMode);
  
  useEffect(() => {
    if (isFocusMode) {
      setIsDockMinimized(true);
    }
  }, [isFocusMode]);
  const [activeFormats, setActiveFormats] = useState({
    bold: false,
    italic: false,
    underline: false,
    strikeThrough: false,
    h2: false,
    blockquote: false,
    list: false,
  });
  
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [showRecordingOverlay, setShowRecordingOverlay] = useState<boolean>(false);
  const [interimText, setInterimText] = useState<string>('');
  const interimTextRef = useRef<string>('');
  const isOverlayActiveRef = useRef<boolean>(false);
  const [recordedSessionText, setRecordedSessionText] = useState<string>('');
  const recordedSessionTextRef = useRef<string>('');
  const [isTranscriptionEnabled, setIsTranscriptionEnabled] = useState<boolean>(true);
  const isTranscriptionEnabledRef = useRef<boolean>(true);
  const [recordingOverlayMode, setRecordingOverlayMode] = useState<'voice-dictation' | 'speech-to-text'>('voice-dictation');
  const shouldDiscardRecordingRef = useRef<boolean>(false);
  const savedSelectionRef = useRef<Range | null>(null);
  const currentSessionIdRef = useRef<number>(0);
  const recognitionRef = useRef<any>(null);
  const nativeRecordingActiveRef = useRef<boolean>(false);
  const nativeSpeechActiveRef = useRef<boolean>(false);
  const nativeSpeechRestartTimerRef = useRef<number | null>(null);
  const shouldBeRecordingRef = useRef<boolean>(false);
  const shouldRestartSpeechRef = useRef<boolean>(true);
  const [speechError, setSpeechError] = useState<string | null>(null);

  // Clean up speech recognition on unmount
  useEffect(() => {
    return () => {
      shouldBeRecordingRef.current = false;
      if (recognitionRef.current) {
        try {
          recognitionRef.current.onstart = null;
          recognitionRef.current.onresult = null;
          recognitionRef.current.onerror = null;
          recognitionRef.current.onend = null;
          recognitionRef.current.stop();
        } catch (e) {}
      }
      if (isNativePlatform()) {
        void stopNativeSpeechRecognition();
        if (nativeRecordingActiveRef.current) {
          VoiceRecorder.stopRecording()
            .catch(() => {})
            .finally(() => {
              nativeRecordingActiveRef.current = false;
            });
        }
      }
    };
  }, []);

  const clearNativeSpeechRestartTimer = () => {
    if (nativeSpeechRestartTimerRef.current !== null) {
      window.clearTimeout(nativeSpeechRestartTimerRef.current);
      nativeSpeechRestartTimerRef.current = null;
    }
  };

  const normalizeTranscriptForCompare = (text: string): string => (
    text.toLowerCase().replace(/\s+/g, ' ').trim()
  );

  const isDuplicateTranscriptSegment = (currentText: string, nextSegment: string): boolean => {
    const current = normalizeTranscriptForCompare(currentText);
    const next = normalizeTranscriptForCompare(nextSegment);
    return !!current && !!next && current.endsWith(next);
  };

  const appendNativeTranscriptSegment = (segment: string) => {
    const text = segment.trim();
    if (!text || isDuplicateTranscriptSegment(recordedSessionTextRef.current, text)) return;

    const current = recordedSessionTextRef.current.trim();
    recordedSessionTextRef.current = current ? `${current} ${text} ` : `${text} `;
    setRecordedSessionText(recordedSessionTextRef.current);
  };

  const finalizeNativeSpeechInterim = () => {
    appendNativeTranscriptSegment(interimTextRef.current);
    interimTextRef.current = '';
    setInterimText('');
  };

  const getNativeTranscriptSnapshot = (): string => {
    const finalizedText = recordedSessionTextRef.current.trim();
    const interim = interimTextRef.current.trim();

    if (!interim || isDuplicateTranscriptSegment(finalizedText, interim)) {
      return finalizedText;
    }

    return finalizedText ? `${finalizedText} ${interim}` : interim;
  };

  const normalizeNativeSpeechError = (error: unknown): string => {
    const message = error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
    const normalized = message.toLowerCase();

    if (normalized.includes('permission')) return 'not-allowed';
    if (normalized.includes('network')) return 'network';
    if (normalized.includes('busy')) return 'busy';
    if (normalized.includes('not available')) return 'unsupported';
    if (normalized.includes('no speech') || normalized.includes('no match')) return 'no-speech';
    if (normalized.includes('audio')) return 'audio';
    return 'unknown';
  };

  const scheduleNativeSpeechRestart = () => {
    clearNativeSpeechRestartTimer();

    if (!shouldBeRecordingRef.current || !shouldRestartSpeechRef.current || !isTranscriptionEnabledRef.current) {
      return;
    }

    nativeSpeechRestartTimerRef.current = window.setTimeout(() => {
      nativeSpeechRestartTimerRef.current = null;

      if (shouldBeRecordingRef.current && shouldRestartSpeechRef.current && isTranscriptionEnabledRef.current) {
        void startNativeSpeechRecognition();
      }
    }, 250);
  };

  const stopNativeSpeechRecognition = async () => {
    clearNativeSpeechRestartTimer();

    try {
      const listening = await NativeSpeechRecognition.isListening();
      if (listening.listening) {
        await NativeSpeechRecognition.stop();
      }
    } catch (e) {
      if (nativeSpeechActiveRef.current) {
        try {
          await NativeSpeechRecognition.stop();
        } catch (stopError) {}
      }
    }

    try {
      await NativeSpeechRecognition.removeAllListeners();
    } catch (e) {}
    nativeSpeechActiveRef.current = false;
  };

  const startNativeSpeechRecognition = async (): Promise<boolean> => {
    if (!isTranscriptionEnabledRef.current) return false;
    clearNativeSpeechRestartTimer();

    try {
      const available = await NativeSpeechRecognition.available();
      if (!available.available) {
        setSpeechError('unsupported');
        return false;
      }

      const permission = await NativeSpeechRecognition.requestPermissions();
      if (permission.speechRecognition !== 'granted') {
        setSpeechError('not-allowed');
        return false;
      }

      await NativeSpeechRecognition.removeAllListeners();
      await NativeSpeechRecognition.addListener('partialResults', (data) => {
        const text = data.matches?.[0]?.trim() || '';
        interimTextRef.current = text;
        setInterimText(text);
      });
      await NativeSpeechRecognition.addListener('listeningState', (data) => {
        if (data.status === 'started') {
          nativeSpeechActiveRef.current = true;
          setIsRecording(true);
          setSpeechError(null);
          return;
        }

        nativeSpeechActiveRef.current = false;
        finalizeNativeSpeechInterim();
        scheduleNativeSpeechRestart();
      });

      await NativeSpeechRecognition.start({
        language: navigator.language || 'en-US',
        maxResults: 3,
        partialResults: true,
        popup: false,
      });
      nativeSpeechActiveRef.current = true;
      setSpeechError(null);
      return true;
    } catch (error) {
      console.error('Native speech recognition error:', error);
      nativeSpeechActiveRef.current = false;
      const normalizedError = normalizeNativeSpeechError(error);
      if (normalizedError === 'no-speech') {
        scheduleNativeSpeechRestart();
      } else {
        setSpeechError(normalizedError);
        shouldRestartSpeechRef.current = false;
      }
      return false;
    }
  };

  const startNativeRecording = async (
    isResume: boolean = false,
    mode: 'voice-dictation' | 'speech-to-text' = 'voice-dictation',
  ) => {
    try {
      if (isResume && mode === 'speech-to-text') {
        shouldBeRecordingRef.current = true;
        shouldRestartSpeechRef.current = true;
        isOverlayActiveRef.current = true;
        setIsRecording(true);
        const speechStarted = await startNativeSpeechRecognition();
        if (!speechStarted) {
          shouldBeRecordingRef.current = false;
          setIsRecording(false);
          onShowToast?.('Voice-to-text is not available. Check microphone permission and Android speech services.', 'warning');
        }
        return;
      }

      if (isResume && nativeRecordingActiveRef.current) {
        await VoiceRecorder.resumeRecording();
        shouldBeRecordingRef.current = true;
        isOverlayActiveRef.current = true;
        setIsRecording(true);
        return;
      }

      if (!isResume) {
        recordedSessionTextRef.current = '';
        setRecordedSessionText('');
        setInterimText('');
        interimTextRef.current = '';
        setSpeechError(null);
        shouldRestartSpeechRef.current = true;
        setRecordingOverlayMode(mode);
        shouldDiscardRecordingRef.current = false;

        if (!activeBlockId) {
          const now = new Date();
          setCurrentTimeText(now.toTimeString().split(' ')[0].substring(0, 5));
        }

        if (mode === 'speech-to-text') {
          setIsTranscriptionEnabled(true);
          isTranscriptionEnabledRef.current = true;
        } else {
          setIsTranscriptionEnabled(false);
          isTranscriptionEnabledRef.current = false;
          shouldRestartSpeechRef.current = false;
        }
      }

      if (mode === 'speech-to-text') {
        isOverlayActiveRef.current = true;
        setShowRecordingOverlay(true);
        shouldBeRecordingRef.current = true;
        setIsRecording(true);
        const speechStarted = await startNativeSpeechRecognition();
        if (!speechStarted) {
          shouldBeRecordingRef.current = false;
          isOverlayActiveRef.current = false;
          setIsRecording(false);
          setShowRecordingOverlay(false);
          onShowToast?.('Voice-to-text is not available. Check microphone permission and Android speech services.', 'warning');
        }
        return;
      }

      const canRecord = await VoiceRecorder.canDeviceVoiceRecord();
      if (!canRecord.value) {
        onShowToast?.('This device cannot record audio.', 'warning');
        setShowRecordingOverlay(false);
        return;
      }

      const permission = await VoiceRecorder.requestAudioRecordingPermission();
      if (!permission.value) {
        onShowToast?.('Microphone permission is required for voice recording.', 'error');
        setShowRecordingOverlay(false);
        return;
      }

      isOverlayActiveRef.current = true;
      setShowRecordingOverlay(true);
      shouldBeRecordingRef.current = true;
      await VoiceRecorder.startRecording();
      nativeRecordingActiveRef.current = true;
      setIsRecording(true);
    } catch (error) {
      console.error('Native recording start failed:', error);
      onShowToast?.('Native voice recording could not start. Check microphone permissions.', 'error');
      nativeRecordingActiveRef.current = false;
      shouldBeRecordingRef.current = false;
      setIsRecording(false);
      setShowRecordingOverlay(false);
    }
  };

  const finishNativeRecording = async (discard: boolean = false) => {
    shouldBeRecordingRef.current = false;
    isOverlayActiveRef.current = false;

    const textToInsert = !discard && isTranscriptionEnabledRef.current
      ? getNativeTranscriptSnapshot()
      : '';

    await stopNativeSpeechRecognition();
    setIsRecording(false);

    try {
      if (nativeRecordingActiveRef.current) {
        const recording = await VoiceRecorder.stopRecording();
        nativeRecordingActiveRef.current = false;

        const recordingValue = recording.value as {
          recordDataBase64?: string;
          mimeType?: string;
          uri?: string;
        };
        const mimeType = recordingValue.mimeType || 'audio/aac';
        let mediaUri: string | null = null;
        if (!discard && recordingValue.uri) {
          mediaUri = Capacitor.convertFileSrc(recordingValue.uri);
        } else if (!discard && recordingValue.recordDataBase64) {
          const dataUri = recordingValue.recordDataBase64.startsWith('data:')
            ? recordingValue.recordDataBase64
            : `data:${mimeType};base64,${recordingValue.recordDataBase64}`;
          mediaUri = await persistMediaDataUri(dataUri, 'audio', mimeType);
        }

        if (mediaUri) {
          if (activeBlockId) {
            setBlocks(prev => prev.map(b => b.id === activeBlockId ? { ...b, audioUri: mediaUri } : b));
          } else {
            setAudioUri(mediaUri);
          }
        }
      }
    } catch (error) {
      if (!discard) {
        console.error('Native recording stop failed:', error);
        onShowToast?.('Could not save the voice recording.', 'error');
      }
      nativeRecordingActiveRef.current = false;
    }

    setInterimText('');
    interimTextRef.current = '';
    recordedSessionTextRef.current = '';
    setRecordedSessionText('');
    shouldDiscardRecordingRef.current = false;
    setShowRecordingOverlay(false);

    if (textToInsert) {
      insertTranscribedText(textToInsert);
    }
  };

  const startSpeechRecognitionInstance = () => {
    if (!audioService.getRecordingSupport().speechRecognition) return;

    const SpeechRecognition = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognition) return;

    // Discard any existing recognition instance to prevent collision
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onstart = null;
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
      } catch (e) {}
    }

    // Generate a fresh unique session ID
    currentSessionIdRef.current += 1;
    const thisSessionId = currentSessionIdRef.current;

    const recognition = new SpeechRecognition();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';

    // Keep instance-specific finalized index in closure to prevent cross-session leaking
    let lastFinalizedIndex = -1;

    recognition.onstart = () => {
      if (thisSessionId !== currentSessionIdRef.current) return;
      setIsRecording(true);
    };

    recognition.onresult = (event: any) => {
      if (thisSessionId !== currentSessionIdRef.current) return;
      if (!isOverlayActiveRef.current || !isTranscriptionEnabledRef.current) return;

      let currentInterim = '';
      let hasChanges = false;

      for (let i = lastFinalizedIndex + 1; i < event.results.length; ++i) {
        const result = event.results[i];
        if (result.isFinal) {
          const text = result[0].transcript.trim();
          if (text) {
            const current = recordedSessionTextRef.current;
            const needsSpace = current && !current.endsWith(' ') && !text.startsWith(' ');
            recordedSessionTextRef.current += (needsSpace ? ' ' : '') + text + ' ';
            hasChanges = true;
          }
          lastFinalizedIndex = i;
        } else {
          currentInterim += result[0].transcript;
        }
      }

      interimTextRef.current = currentInterim;
      setInterimText(currentInterim);

      if (hasChanges) {
        setRecordedSessionText(recordedSessionTextRef.current);
      }
    };

    recognition.onerror = (event: any) => {
      if (thisSessionId !== currentSessionIdRef.current) return;
      console.error('Speech recognition error:', event.error);
      if (event.error === 'no-speech') {
        return;
      }
      if (event.error === 'not-allowed') {
        if (onShowToast) {
          onShowToast('Microphone access was denied. Please allow microphone permissions in your browser/device settings.', 'error');
        } else {
          alert('Microphone access was denied. Please allow microphone permissions to use voice dictation and audio recording.');
        }
        shouldBeRecordingRef.current = false;
        setIsRecording(false);
        if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
          try { mediaRecorderRef.current.stop(); } catch (e) {}
        }
      } else if (event.error === 'network') {
        setSpeechError('network');
        shouldRestartSpeechRef.current = false;
      } else if (event.error !== 'aborted') {
        setSpeechError(event.error || 'unknown');
        shouldRestartSpeechRef.current = false;
      }
    };

    recognition.onend = () => {
      if (thisSessionId !== currentSessionIdRef.current) return;
      if (shouldBeRecordingRef.current && shouldRestartSpeechRef.current) {
        // Automatically restart speech recognition in a new clean session instance
        startSpeechRecognitionInstance();
      }
    };

    recognitionRef.current = recognition;

    try {
      recognition.start();
    } catch (e: any) {
      if (e.name === 'InvalidStateError') {
        setIsRecording(true);
      } else {
        console.error('Error starting recognition:', e);
        setSpeechError('network');
      }
    }
  };

  const startRecording = (isResume: boolean = false, mode: 'voice-dictation' | 'speech-to-text' = 'voice-dictation') => {
    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      savedSelectionRef.current = selection.getRangeAt(0);
    }

    if (isNativePlatform()) {
      void startNativeRecording(isResume, mode);
      return;
    }

    const recordingSupport = audioService.getRecordingSupport();
    if (mode === 'speech-to-text' && !recordingSupport.speechRecognition) {
      onShowToast?.('Dictation is not supported by this browser. Audio notes are still available.', 'warning');
      return;
    }
    if (mode === 'voice-dictation' && !recordingSupport.mediaRecorder) {
      onShowToast?.('Audio recording is not supported by this browser.', 'warning');
      return;
    }

    if (isResume && mode === 'speech-to-text') {
      isOverlayActiveRef.current = true;
      shouldBeRecordingRef.current = true;
      shouldRestartSpeechRef.current = true;
      setIsRecording(true);
      setSpeechError(null);
      startSpeechRecognitionInstance();
      return;
    }
    
    if (isResume && mediaRecorderRef.current && mediaRecorderRef.current.state === 'paused') {
      try {
        mediaRecorderRef.current.resume();
      } catch (e) {
        console.error('Failed to resume mediaRecorder:', e);
      }
      isOverlayActiveRef.current = true;
      shouldBeRecordingRef.current = true;
      setIsRecording(true);
      setSpeechError(null);
      return;
    }

    if (!isResume) {
      recordedSessionTextRef.current = '';
      setRecordedSessionText('');
      setInterimText('');
      interimTextRef.current = '';
      setSpeechError(null);
      shouldRestartSpeechRef.current = true;
      setRecordingOverlayMode(mode);
      shouldDiscardRecordingRef.current = false;

      // Update timestamp for new moment if starting a fresh recording
      if (!activeBlockId) {
        const now = new Date();
        setCurrentTimeText(now.toTimeString().split(' ')[0].substring(0, 5));
      }
      
      // If speech-to-text mode, force transcription enabled
      if (mode === 'speech-to-text') {
        setIsTranscriptionEnabled(true);
        isTranscriptionEnabledRef.current = true;
      } else {
        setIsTranscriptionEnabled(false);
        isTranscriptionEnabledRef.current = false;
        shouldRestartSpeechRef.current = false;
      }
    }
    
    isOverlayActiveRef.current = true;
    setShowRecordingOverlay(true);
    shouldBeRecordingRef.current = true;


    if (mode === 'speech-to-text') {
      startSpeechRecognitionInstance();
      return;
    }

    if (recordingSupport.mediaRecorder) {
      navigator.mediaDevices.getUserMedia({ audio: true })
        .then(stream => {
          let mediaRecorder: MediaRecorder;
          try {
            mediaRecorder = new MediaRecorder(stream);
          } catch (err) {
            console.error('MediaRecorder initialization error:', err);
            stream.getTracks().forEach(track => track.stop());
            onShowToast?.('Audio recording could not be initialized on this device.', 'error');
            shouldBeRecordingRef.current = false;
            setIsRecording(false);
            setShowRecordingOverlay(false);
            return;
          }
          mediaRecorderRef.current = mediaRecorder;
          
          if (!isResume) {
            audioChunksRef.current = [];
          }
          
          mediaRecorder.ondataavailable = (e) => {
            if (e.data.size > 0) {
              audioChunksRef.current.push(e.data);
            }
          };
          
          mediaRecorder.onstop = () => {
            if (shouldDiscardRecordingRef.current) {
              stream.getTracks().forEach(track => track.stop());
              return;
            }

            const audioBlob = new Blob(audioChunksRef.current, { type: mediaRecorder.mimeType || 'audio/webm' });

            if (isTranscriptionEnabledRef.current && recordingOverlayMode === 'voice-dictation') {
              stream.getTracks().forEach(track => track.stop());
              return;
            }

            const reader = new FileReader();
            reader.onloadend = async () => {
              const base64data = reader.result as string;
              const mediaUri = await persistMediaDataUri(
                base64data,
                'audio',
                mediaRecorder.mimeType || 'audio/webm',
              );
              
              if (activeBlockId) {
                setBlocks(prev => prev.map(b => b.id === activeBlockId ? { ...b, audioUri: mediaUri } : b));
              } else {
                setAudioUri(mediaUri);
              }
            };
            reader.readAsDataURL(audioBlob);
            
            stream.getTracks().forEach(track => track.stop());
          };

          setIsRecording(true);

          mediaRecorder.start(250);
        })
        .catch(err => {
          console.error('Media stream error:', err);
          if (onShowToast) {
            onShowToast('Microphone access was denied or could not be initialized. Please check permission settings.', 'error');
          } else {
            alert('Microphone access was denied or could not be initialized. Please allow microphone permissions.');
          }
          shouldBeRecordingRef.current = false;
          setIsRecording(false);
          setShowRecordingOverlay(false);
        });
    } else {
      if (onShowToast) {
        onShowToast('Audio recording is not supported in this browser environment.', 'warning');
      } else {
        alert('Audio recording is not supported in this browser environment.');
      }
      shouldBeRecordingRef.current = false;
      setIsRecording(false);
    }
  };

  const pauseRecording = async () => {
    if (isNativePlatform()) {
      shouldBeRecordingRef.current = false;
      if (isTranscriptionEnabledRef.current) {
        finalizeNativeSpeechInterim();
      }
      await stopNativeSpeechRecognition();
      setIsRecording(false);
      if (nativeRecordingActiveRef.current) {
        try {
          await VoiceRecorder.pauseRecording();
        } catch (error) {
          console.warn('Native recording pause failed:', error);
        }
      }
      return;
    }

    shouldBeRecordingRef.current = false;
    try {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    } catch (e) {}
    setIsRecording(false);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state === 'recording') {
      try {
        mediaRecorderRef.current.pause();
      } catch (e) {}
    }
  };

  const cancelRecording = () => {
    if (isNativePlatform()) {
      shouldDiscardRecordingRef.current = true;
      void finishNativeRecording(true);
      return;
    }

    shouldDiscardRecordingRef.current = true;
    shouldBeRecordingRef.current = false;
    isOverlayActiveRef.current = false;
    try {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    } catch (e) {}
    setIsRecording(false);
    setShowRecordingOverlay(false);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {}
    }
    
    setInterimText('');
    interimTextRef.current = '';
    recordedSessionTextRef.current = '';
    setRecordedSessionText('');
  };

  const insertTranscribedText = (text: string) => {
    if (!text) return;
    
    let inserted = false;
    
    // 1. Try to insert at the cursor position using DOM execCommand (nice for UX if supported)
    const activeEditor = document.activeElement as HTMLElement;
    const isEditorActive = activeEditor && activeEditor.hasAttribute('contenteditable') && activeEditor.classList.contains('rich-text-editor');
    
    if (isEditorActive) {
      try {
        if (savedSelectionRef.current) {
          const selection = window.getSelection();
          selection?.removeAllRanges();
          selection?.addRange(savedSelectionRef.current);
        }
        
        document.execCommand('insertText', false, text + ' ');
        // Trigger input event to update React state
        activeEditor.dispatchEvent(new Event('input', { bubbles: true }));
        inserted = true;
      } catch (err) {
        console.warn('execCommand failed, falling back to state update:', err);
      }
    }
    
    // 2. If cursor insertion was not successful or not in an active editor, append directly to state
    if (!inserted) {
      if (activeBlockId) {
        setBlocks(prev => prev.map(b => {
          if (b.id === activeBlockId) {
            const currentBody = b.body || '';
            const newBody = currentBody ? `${currentBody} ${text}` : text;
            return { ...b, body: newBody };
          }
          return b;
        }));
      } else {
        setBody(prev => {
          const currentBody = prev || '';
          return currentBody ? `${currentBody} ${text}` : text;
        });
      }
    }
  };


  const stopRecording = () => {
    if (isNativePlatform()) {
      void finishNativeRecording(false);
      return;
    }

    shouldBeRecordingRef.current = false;
    isOverlayActiveRef.current = false;
    try {
      if (recognitionRef.current) {
        recognitionRef.current.stop();
      }
    } catch (e) {}
    setIsRecording(false);

    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.stop();
      } catch (e) {}
    }
    
    const finalInterim = interimTextRef.current.trim();
    let textToInsert = isTranscriptionEnabledRef.current ? recordedSessionTextRef.current.trim() : '';
    if (isTranscriptionEnabledRef.current && finalInterim) {
      textToInsert += (textToInsert ? ' ' : '') + finalInterim;
    }
    
    setInterimText('');
    interimTextRef.current = '';
    

    setShowRecordingOverlay(false);
    
    if (textToInsert) {
      insertTranscribedText(textToInsert);
    }
    
    recordedSessionTextRef.current = '';
    setRecordedSessionText('');
  };

  const toggleRecording = (mode: 'voice-dictation' | 'speech-to-text' = 'voice-dictation') => {
    if (showRecordingOverlay) {
      stopRecording();
    } else {
      startRecording(false, mode);
    }
  };

  const renderInkBleedingText = (fullText: string, isInterim: boolean = false) => {
    if (!fullText) return null;
    const words = fullText.split(' ');
    return words.map((word, idx) => {
      if (!word) return null;
      return (
        <span
          key={`${word}-${idx}`}
          className={`inline-block mr-1.5 ${
            isInterim ? 'text-brand-pink font-semibold' : 'text-brand-plum'
          }`}
          style={{
            animation: 'ink-bleed 1.1s cubic-bezier(0.15, 0.85, 0.35, 1) forwards',
            opacity: 0,
          }}
        >
          {word}
        </span>
      );
    });
  };
  
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Load entry details if editing or deep-linking
  useEffect(() => {
    let cancelled = false;

    const loadEntry = async () => {
      if (isEditing && entryId) {
        const entryObj = await diaryRepository.getEntry(entryId);
        if (cancelled) return;
        if (entryObj) {
          setDiaryId(entryObj.diaryId);
          setDate(entryObj.date);
        
        // Load time if present, otherwise extract from createdAt
        const entryTime = entryObj.time || new Date(entryObj.createdAt).toTimeString().split(' ')[0].substring(0, 5);
        setTime(entryTime);
        setCurrentTimeText(entryTime);

        setTitle(entryObj.title === 'Untitled entry' ? '' : entryObj.title);
        
        const entryBlocks = [...(entryObj.blocks || [])];
        // If it's an existing standard entry with no blocks, wrap the body in an initial block
        let migratedAudio = false;
        if (entryBlocks.length === 0 && (entryObj.body || entryObj.audioUri)) {
          entryBlocks.push({
            id: `block-initial-${Date.now()}`,
            time: entryTime,
            body: entryObj.body || '',
            audioUri: entryObj.audioUri
          });
          migratedAudio = true;
        }
        
        setBlocks(entryBlocks);
        
        // Start the single editor box empty for writing a fresh moment
        setBody('');
        setActiveBlockId(null);
        
        // Update current time text to actual now for the new moment
        const now = new Date();
        setCurrentTimeText(now.toTimeString().split(' ')[0].substring(0, 5));
        
        // Match pre-saved mood
        const matchedMood = availableMoods.find(m => m.name === entryObj.moodName) || availableMoods[0] || { name: 'Joyful', emoji: '😊' };
        setMood(matchedMood);
        setSelectedTags(entryObj.tags || []);
        setPhotoUris(entryObj.photoUris || []);
        if (!migratedAudio) {
          setAudioUri(entryObj.audioUri);
        } else {
          setAudioUri(undefined);
        }
        }
      } else {
        const now = new Date();
        setCurrentTimeText(now.toTimeString().split(' ')[0].substring(0, 5));

        if (initialDate) {
          setDate(initialDate);
        }
        if (initialPrompt) {
          setBody(`<blockquote>${initialPrompt}</blockquote><br/>`);
        }
        if (availableTags.includes('happy')) {
          setSelectedTags(['happy']);
        }
      }
    };

    void loadEntry();
    return () => {
      cancelled = true;
    };
  }, [entryId, isEditing, initialDate, initialPrompt]);

  const liveWordCount = useMemo(() => {
    const previousBlocksWords = blocks
      .filter(b => b.id !== activeBlockId)
      .reduce((acc, b) => {
        const text = richTextHtmlToPlainText(b.body);
        return acc + (text ? text.split(/\s+/).filter(Boolean).length : 0);
      }, 0);
    const currentWords = richTextHtmlToPlainText(body);
    const currentWordsCount = currentWords ? currentWords.split(/\s+/).filter(Boolean).length : 0;
    return previousBlocksWords + currentWordsCount;
  }, [blocks, body, activeBlockId]);



  // Handle local photo file upload
  const handlePhotoUpload = (e: React.ChangeEvent<HTMLInputElement>) => {
    const files = e.target.files;
    if (!files) return;

    const selectedFiles: File[] = Array.from(files);
    void (async () => {
      const results: Array<string | null> = new Array(selectedFiles.length).fill(null);
      let nextIndex = 0;
      const worker = async () => {
        while (nextIndex < selectedFiles.length) {
          const index = nextIndex;
          nextIndex += 1;
          try {
            results[index] = await persistOptimizedImageFile(selectedFiles[index], 'photo');
          } catch (error) {
            console.warn('Photo could not be attached:', error);
            onShowToast?.('One photo could not be attached.', 'warning');
          }
        }
      };
      await Promise.all(Array.from({ length: Math.min(2, selectedFiles.length) }, () => worker()));
      const orderedUris = results.filter((uri): uri is string => Boolean(uri));
      if (orderedUris.length > 0) {
        setPhotoUris(prev => [...prev, ...orderedUris]);
      }
    })();
    e.target.value = '';
  };

  const removePhoto = (idx: number) => {
    setPhotoUris(prev => prev.filter((_, i) => i !== idx));
  };

  const handleTagToggle = (tag: string) => {
    if (selectedTags.includes(tag)) {
      setSelectedTags(prev => prev.filter(t => t !== tag));
    } else {
      setSelectedTags(prev => [...prev, tag]);
    }
  };

  const handleSave = async () => {
    if (isSaving) return;

    const finalTitle = title.trim() || 'Untitled entry';
    
    let finalBlocks = [...blocks].filter(b => {
      const hasText = richTextHtmlToPlainText(b.body) !== '';
      return hasText || b.audioUri;
    });
    
    // Add new moment block if drafting area is not empty OR there is an audio note
    const hasDraftText = richTextHtmlToPlainText(body) !== '';
    if (hasDraftText || audioUri) {
      const newBlock: EntryBlock = {
        id: `block-${Date.now()}`,
        time: currentTimeText,
        body,
        audioUri // Store the current recording in the block
      };
      finalBlocks.push(newBlock);
    }
    
    // If absolutely everything is empty, don't save (or maybe show warning)
    if (finalBlocks.length === 0 && !title.trim()) {
      onBack(); // Just go back if they saved nothing
      return;
    }
    
    finalBlocks.sort((a, b) => a.time.localeCompare(b.time));
    // Save all block texts combined as the overall entry body so standard view displays them
    const finalBody = finalBlocks.map(b => b.body).filter(Boolean).join('<br/><br/>');

    try {
      setIsSaving(true);
      const saveOperation = async () => {
        if (isEditing && entryId) {
          const entryObj = await diaryRepository.getEntry(entryId);
          if (entryObj) {
            const updated: Entry = {
              ...entryObj,
              diaryId,
              date,
              time: finalBlocks.length > 0 ? finalBlocks[0].time : time,
              title: finalTitle,
              body: finalBody,
              moodName: mood.name,
              moodEmoji: mood.emoji,
              tags: selectedTags,
              photoUris,
              photoCount: photoUris.length,
              wordCount: liveWordCount,
              audioUri: undefined,
              updatedAt: Date.now(),
              blocks: finalBlocks,
            };
            await diaryRepository.updateEntry(updated);
          }
        } else {
          await diaryRepository.createEntry({
            diaryId,
            date,
            time: finalBlocks.length > 0 ? finalBlocks[0].time : time,
            title: finalTitle,
            body: finalBody,
            moodName: mood.name,
            moodEmoji: mood.emoji,
            tags: selectedTags,
            photoUris,
            audioUri: undefined,
            blocks: finalBlocks,
          });
        }

        if (hasDraftText || audioUri) {
          setAudioUri(undefined);
          setBody('');
        }
        onBack();
        onShowToast('Saved to this device', 'success');
      };

      await measureAsync('app.entrySaveToNavigation', saveOperation, {
        isEditing,
        hasMedia: photoUris.length > 0,
        blockCount: finalBlocks.length,
      });
    } catch (saveError: any) {
      onShowToast(saveError?.message || 'Entry could not be saved.', saveError instanceof SyncConflictError ? 'warning' : 'error');
      if (saveError instanceof SyncConflictError) {
        await onRefreshEntries();
        onBack();
      }
    } finally {
      setIsSaving(false);
    }
  };

  const handleDeleteEntry = async () => {
    if (entryId) {
      await diaryRepository.deleteEntry(entryId);
      onBack();
      onShowToast('Deleted on this device', 'success');
    }
  };

  const triggerPhotoInput = () => {
    fileInputRef.current?.click();
  };

  const isInsideBlockElement = (tagName: string): boolean => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return false;
    let node: Node | null = selection.anchorNode;
    while (node && node !== document.body) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.tagName.toLowerCase() === tagName.toLowerCase()) {
          return true;
        }
      }
      node = node.parentNode;
    }
    return false;
  };

  const updateActiveFormats = () => {
    setActiveFormats({
      bold: document.queryCommandState('bold'),
      italic: document.queryCommandState('italic'),
      underline: document.queryCommandState('underline'),
      strikeThrough: document.queryCommandState('strikeThrough'),
      h2: document.queryCommandValue('formatBlock') === 'h2' || isInsideBlockElement('h2'),
      blockquote: document.queryCommandValue('formatBlock') === 'blockquote' || isInsideBlockElement('blockquote'),
      list: document.queryCommandState('insertUnorderedList'),
    });
  };

  useEffect(() => {
    const handleSelectionChange = () => {
      updateActiveFormats();
    };
    document.addEventListener('selectionchange', handleSelectionChange);
    return () => {
      document.removeEventListener('selectionchange', handleSelectionChange);
    };
  }, []);

  const execCommand = (command: string) => {
    document.execCommand(command, false, undefined);
    setTimeout(updateActiveFormats, 10);
  };

  const toggleFormatBlock = (tagName: string) => {
    const selection = window.getSelection();
    if (!selection || selection.rangeCount === 0) return;
    
    // Find nearest ancestor block or container to check tag
    let node: Node | null = selection.anchorNode;
    let isInsideTag = false;
    while (node && node !== document.body) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        const el = node as HTMLElement;
        if (el.tagName.toLowerCase() === tagName.toLowerCase()) {
          isInsideTag = true;
          break;
        }
      }
      node = node.parentNode;
    }

    if (isInsideTag) {
      document.execCommand('formatBlock', false, '<p>');
    } else {
      document.execCommand('formatBlock', false, `<${tagName}>`);
    }
    setTimeout(updateActiveFormats, 10);
  };

  const isAudioRecordingOnly = recordingOverlayMode === 'voice-dictation';

  const recordingOverlayUI = (
    <AnimatePresence>
      {showRecordingOverlay && (
        <motion.div
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={{ opacity: 0 }}
          className="fixed inset-0 z-[100] overflow-y-auto bg-brand-bg/95 dark:bg-brand-plum/95 backdrop-blur-2xl select-none"
        >
          {/* Top action dismiss button */}
          <div className="absolute top-4 right-4 sm:top-6 sm:right-6">
            <motion.button 
              whileHover={{ scale: 1.05 }}
              whileTap={{ scale: 0.95 }}
              onClick={cancelRecording}
              className="p-2.5 sm:p-3 text-brand-pink hover:text-brand-pink-dark bg-white dark:bg-brand-card-bg rounded-full shadow-md border border-brand-border/40"
              title="Discard recording and exit"
            >
              <X className="w-5 h-5 sm:w-6 sm:h-6" />
            </motion.button>
          </div>
          
          <div className="min-h-screen flex flex-col items-center justify-start md:justify-center w-full max-w-xl mx-auto gap-4 sm:gap-6 md:gap-8 py-16 px-4 sm:px-6">
            <div className="text-center space-y-1 select-none">
              <span className="text-[9px] sm:text-[10px] font-extrabold text-brand-pink uppercase tracking-[0.25em] bg-brand-pink/10 px-3 py-1 sm:px-3.5 sm:py-1.5 rounded-full">
                {recordingOverlayMode === 'speech-to-text' ? 'Dictate Text' : 'Audio Note'}
              </span>
              <h2 className="text-xl sm:text-2xl font-serif-diary font-bold text-brand-plum italic pt-1.5 sm:pt-2">
                {recordingOverlayMode === 'speech-to-text' ? 'Speak to Write' : 'Record This Moment'}
              </h2>
              {recordingOverlayMode === 'voice-dictation' && (
                <p className="text-[11px] sm:text-xs text-brand-text-muted font-medium px-2">
                  Record an audio memory and save it with this diary moment.
                </p>
              )}
              
              {/* Transcription Toggle (Only in Voice Sanctuary mode) */}
              {recordingOverlayMode === 'speech-to-text' && (
                <div className="flex justify-center pt-3">
                  <p className="max-w-sm text-[10px] text-brand-text-muted font-semibold">
                    Recognition uses your browser or Android speech service and may require a network connection.
                  </p>
                </div>
              )}
            </div>
            
            <div className="relative flex flex-col items-center justify-center py-2 sm:py-4">
              {isRecording ? (
                <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
                  {/* Multiple cascading breath rings */}
                  <motion.div 
                    animate={{ scale: [1, 1.8, 1], opacity: [0.3, 0, 0.3] }}
                    transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                    className="absolute w-24 h-24 sm:w-32 sm:h-32 rounded-full border-2 border-brand-pink/20"
                  />
                  <motion.div 
                    animate={{ scale: [1, 2.3, 1], opacity: [0.15, 0, 0.15] }}
                    transition={{ duration: 4, repeat: Infinity, ease: "easeInOut", delay: 1 }}
                    className="absolute w-24 h-24 sm:w-32 sm:h-32 rounded-full border border-brand-pink/10"
                  />
                </div>
              ) : null}

              <motion.div 
                whileHover={{ scale: 1.02 }}
                className={`relative z-10 p-5 sm:p-[30px] rounded-full shadow-xl border transition-all duration-500 ${
                  isRecording 
                    ? 'bg-brand-pink text-white border-brand-pink/20 shadow-brand-pink/30 scale-105' 
                    : 'bg-white dark:bg-brand-card-bg text-brand-pink border-brand-border/80 shadow-md'
                }`}
              >
                {isRecording ? <Mic className="w-8 h-8 sm:w-12 sm:h-12" /> : <MicOff className="w-8 h-8 sm:w-12 sm:h-12" />}
              </motion.div>

              {/* Simulated bouncing wave equalizer indicator */}
              {isRecording && (
                <div className="flex items-center gap-1 sm:gap-1.5 mt-4 sm:mt-6 h-5 sm:h-6 select-none">
                  {[0.4, 0.9, 0.6, 0.3, 0.8, 0.5, 0.9, 0.4, 0.7, 0.3].map((delay, idx) => (
                    <motion.div
                      key={idx}
                      animate={{ height: [5, 18, 5] }}
                      transition={{ duration: 1.2, repeat: Infinity, ease: "easeInOut", delay: delay }}
                      className="w-1 sm:w-1.5 bg-brand-pink rounded-full"
                    />
                  ))}
                </div>
              )}
            </div>

            {/* Status indicators and Connection notices */}
            {(isAudioRecordingOnly || Boolean(speechError)) && (
              <div className="flex flex-col items-center gap-2 max-w-md w-full">
                <div className="flex flex-wrap items-center justify-center gap-2 sm:gap-4 bg-white/70 dark:bg-brand-card-bg/85 px-3 py-1.5 sm:px-4 sm:py-2 rounded-2xl border border-brand-border/60 text-[10px] sm:text-xs font-semibold">
                  {isAudioRecordingOnly && <span className="flex items-center gap-1.5 text-brand-plum">
                    <span className={`w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full ${isTranscriptionEnabled ? 'bg-brand-text-muted/40' : 'bg-emerald-500 animate-pulse'}`} />
                    <span>Raw Audio: {isTranscriptionEnabled ? 'Off' : 'Active'} 🎙️</span>
                  </span>}
                  {!isAudioRecordingOnly && (
                    <>
                      <span className="hidden sm:inline w-px h-4 bg-brand-border" />
                      <span className={`flex items-center gap-1.5 ${!isTranscriptionEnabled ? 'text-brand-text-muted opacity-50' : 'text-brand-plum'}`}>
                        {speechError || !isTranscriptionEnabled ? (
                          <>
                            <span className={`w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full ${!isTranscriptionEnabled ? 'bg-brand-text-muted/40' : 'bg-amber-500'}`} />
                            <span>Dictation: {speechError ? 'Offline' : 'Off'}</span>
                          </>
                        ) : (
                          <>
                            <span className="w-2 h-2 sm:w-2.5 sm:h-2.5 rounded-full bg-emerald-500 animate-pulse" />
                            <span>Dictation: Transcribing ✍️</span>
                          </>
                        )}
                      </span>
                    </>
                  )}
                </div>

                {speechError && (
                  <motion.div 
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    className="bg-amber-500/10 text-amber-700 dark:text-amber-300 border border-amber-500/30 text-[10px] sm:text-xs px-3 py-2 sm:px-4 sm:py-2.5 rounded-2xl text-center leading-relaxed font-semibold shadow-sm"
                  >
                    {speechError === 'network' ? (
                      "Dictation lost its network connection. Finished words are preserved; retry later or use Audio Note."
                    ) : speechError === 'unsupported' ? (
                      "Dictation is unavailable here. Finished words are preserved; retry later or use Audio Note."
                    ) : (
                      `Dictation paused (${speechError}). Finished words are preserved; retry later or use Audio Note.`
                    )}
                  </motion.div>
                )}
              </div>
            )}

            {/* Live Transcription Box */}
            <div className="text-center w-full space-y-2 sm:space-y-4">
              <h3 className="text-[10px] sm:text-xs font-bold text-brand-pink uppercase tracking-widest">
                {isRecording 
                  ? (isTranscriptionEnabled ? 'Listening and transcribing...' : 'Audio recording active') 
                  : 'Recording is paused'}
              </h3>
              
              <div className="min-h-[100px] sm:min-h-[140px] w-full p-4 sm:p-6 bg-white/70 dark:bg-brand-card-bg/75 backdrop-blur-md rounded-2xl sm:rounded-3xl border border-brand-border/60 text-brand-plum text-sm sm:text-base md:text-lg leading-[1.6] sm:leading-[1.7] shadow-inner max-h-36 sm:max-h-48 overflow-y-auto no-scrollbar text-left font-serif-diary italic flex flex-wrap content-start">
                <div className="w-full flex flex-wrap">
                  {renderInkBleedingText(recordedSessionText, false)}
                  {renderInkBleedingText(interimText, true)}
                </div>
                {!recordedSessionText && !interimText && (
                  <span className="opacity-45 text-center block w-full py-4 sm:py-8 font-sans text-xs font-semibold uppercase tracking-wider">
                    {isTranscriptionEnabled ? 'Start speaking to write...' : 'Transcription is disabled. Recording raw audio only.'}
                  </span>
                )}
              </div>
            </div>

            {/* Audio Command Controls */}
            <div className="flex flex-wrap items-center justify-center gap-3 sm:gap-4.5">
              <motion.button
                type="button"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={cancelRecording}
                className="flex items-center gap-1.5 sm:gap-2 px-4 py-2.5 sm:px-6 sm:py-3 bg-red-50 hover:bg-red-100 text-red-600 font-bold rounded-full shadow-md border border-red-200 text-[10px] sm:text-xs uppercase tracking-wider"
              >
                <X className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-red-500" /> 
                <span>Cancel</span>
              </motion.button>

              {isRecording ? (
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={pauseRecording}
                  className="flex items-center gap-1.5 sm:gap-2 px-4 py-2.5 sm:px-6 sm:py-3 bg-white dark:bg-brand-card-bg text-brand-plum font-bold rounded-full shadow-md hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 transition-colors border border-brand-border text-[10px] sm:text-xs uppercase tracking-wider"
                >
                  <Pause className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-brand-pink" /> 
                  <span>Pause</span>
                </motion.button>
              ) : (
                <motion.button
                  type="button"
                  whileHover={{ scale: 1.03 }}
                  whileTap={{ scale: 0.97 }}
                  onClick={() => startRecording(true, recordingOverlayMode)}
                  className="flex items-center gap-1.5 sm:gap-2 px-4 py-2.5 sm:px-6 sm:py-3 bg-brand-pink text-white font-bold rounded-full shadow-lg hover:bg-brand-pink-dark transition-all shadow-brand-pink/15 text-[10px] sm:text-xs uppercase tracking-wider"
                >
                  <Play className="w-3.5 h-3.5 sm:w-4 sm:h-4" /> 
                  <span>Resume</span>
                </motion.button>
              )}
              
              <motion.button
                type="button"
                whileHover={{ scale: 1.03 }}
                whileTap={{ scale: 0.97 }}
                onClick={stopRecording}
                className="flex items-center gap-1.5 sm:gap-2 px-4 py-2.5 sm:px-6 sm:py-3 bg-brand-plum dark:bg-white text-white dark:text-brand-plum font-bold rounded-full shadow-md hover:opacity-90 transition-colors text-[10px] sm:text-xs uppercase tracking-wider"
              >
                <Square className="w-3.5 h-3.5 sm:w-4 sm:h-4 text-brand-pink" /> 
                <span>Finish</span>
              </motion.button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  );

  const localReflectionUI = (
    <section className="rounded-3xl border border-brand-border bg-brand-card-bg p-4 flex flex-col gap-3">
      <div className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <Sparkles className="w-4 h-4 text-brand-pink" />
          <div>
            <h3 className="text-xs font-bold text-brand-plum">Local Reflection</h3>
            <p className="text-[9px] text-brand-sage">Private keyword analysis performed entirely on this device.</p>
          </div>
        </div>
        <button
          type="button"
          onClick={() => void handleAiEnhance()}
          disabled={aiLoading}
          className="px-3 py-2 rounded-xl bg-brand-sage text-white text-[10px] font-bold disabled:opacity-50"
        >
          {aiLoading ? 'Reflecting...' : 'Reflect locally'}
        </button>
      </div>
      {aiError && <p className="text-[10px] text-brand-pink-dark">{aiError}</p>}
      {aiResult && (
        <div className="rounded-2xl bg-brand-bg/60 border border-brand-border/40 p-3 flex flex-col gap-2">
          <p className="text-xs text-brand-plum leading-relaxed">{aiResult.reflection}</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" onClick={() => applyAiMood(aiResult.mood)} className="px-2.5 py-1 rounded-full bg-brand-pink/10 text-brand-pink text-[10px] font-bold">
              Use mood: {aiResult.mood}
            </button>
            {aiResult.tags.map(tag => (
              <button key={tag} type="button" onClick={() => applyAiTag(tag)} className="px-2.5 py-1 rounded-full bg-brand-sage/10 text-brand-sage text-[10px] font-bold">
                +#{tag}
              </button>
            ))}
          </div>
        </div>
      )}
    </section>
  );

  if (isFocusMode) {
    return (
      <div className="fixed inset-0 z-50 bg-brand-bg flex flex-col h-screen overflow-y-auto px-6 py-8 md:py-12 pb-28 focus-mode-safe">
        <div className="max-w-2xl mx-auto w-full flex-grow flex flex-col gap-5">
          
          {/* Distraction-Free Minimalist Top Controls */}
          <header className="flex justify-between items-center text-brand-sage/60 hover:opacity-100 transition-opacity duration-300 select-none pb-3 border-b border-brand-border/10">
            <button 
              onClick={() => {
                setIsFocusMode(false);
                onFocusModeChange?.(false);
              }}
              className="flex items-center gap-1 text-[11px] font-bold px-2.5 py-1 bg-brand-card-bg rounded-lg border border-brand-border/60 text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 transition-all active:scale-95"
              title="Exit Focus Mode"
            >
              <Minimize2 className="w-3 h-3 text-brand-pink" />
              <span>Exit Focus</span>
            </button>

            <div className="flex items-center gap-1.5">
              {showDiarySelector && diaries.length > 0 && (
                <div className="relative">
                  <select
                    value={diaryId}
                    onChange={(e) => setDiaryId(e.target.value)}
                    className="absolute inset-0 opacity-0 cursor-pointer z-10 w-full h-full"
                  >
                    {diaries.map(d => (
                      <option key={d.id} value={d.id}>
                        {d.name}
                      </option>
                    ))}
                  </select>
                  <div className="px-2.5 py-1 rounded-lg bg-brand-card-bg hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 text-[11px] font-bold transition-all flex items-center gap-1.5 border border-brand-border/60 text-brand-plum select-none">
                    <span 
                      className="w-2 h-2 rounded-full border border-white/20 shadow-inner" 
                      style={{ backgroundColor: diaries.find(d => d.id === diaryId)?.color || '#8A3D55' }}
                    />
                    <span className="truncate max-w-[80px]">
                      {diaries.find(d => d.id === diaryId)?.name || 'Select'}
                    </span>
                    <ChevronDown className="w-3 h-3 text-brand-sage" />
                  </div>
                </div>
              )}

              <button
                type="button"
                onClick={() => setFontFamily(prev => prev === 'serif' ? 'sans' : prev === 'sans' ? 'mono' : 'serif')}
                className="px-2.5 py-1 rounded-lg bg-brand-card-bg hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 text-[11px] font-bold transition-all flex items-center gap-1 border border-brand-border/60 text-brand-plum"
                title="Change font style"
              >
                <Type className="w-3 h-3 text-brand-pink" />
                <span>Font: <span className="capitalize">{fontFamily}</span></span>
              </button>

              <button 
                onClick={handleSave}
                disabled={isSaving}
                className="bg-brand-sage hover:bg-brand-sage-dark text-white px-3.5 py-1 rounded-lg text-[11px] font-bold transition-all active:scale-95 shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
              >
                {isSaving ? 'Saving' : 'Save'}
              </button>
            </div>
          </header>

          {/* Minimalist Title */}
          <div className="w-full pt-1">
            <input 
              type="text" 
              data-testid="entry-title-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              placeholder="Give this moment a title..."
              className={`w-full bg-transparent p-0 border-none font-bold text-brand-plum placeholder-brand-sage/35 focus:outline-none focus:ring-0 text-lg md:text-xl pb-1 border-b border-brand-border/15 focus:border-brand-pink/40 transition-colors ${
                fontFamily === 'serif' ? 'font-serif-diary' : fontFamily === 'sans' ? 'font-sans' : 'font-mono'
              }`}
            />
          </div>

          {/* Large Body Area */}
          <div className="flex-grow flex flex-col min-h-[450px]">
            <div className="flex flex-col gap-4 text-left w-full h-full">
              {/* Scrollable history stream of blocks - NOW ALL IN EDIT MODE */}
              {blocks.length > 0 && (
                <div className="flex flex-col gap-6 mb-8">
                  <span className="text-[10px] font-extrabold text-brand-pink uppercase tracking-widest pl-1 border-b border-brand-pink/20 pb-2">
                    Earlier Saved Moments ({blocks.length})
                  </span>
                  <div className="flex flex-col gap-6">
                    {blocks.map((b, index) => {
                      const isMinimized = minimizedBlockIds.has(b.id);
                      return (
                        <div 
                          key={b.id} 
                          className="relative pl-8 border-l-2 border-brand-pink/20 flex flex-col gap-3 group transition-all"
                        >
                          {/* Timeline point */}
                          <div className="absolute -left-[9px] top-2.5 w-4 h-4 rounded-full bg-brand-bg border-2 border-brand-pink group-hover:scale-110 transition-transform" />
                          
                          <div className="flex items-center justify-between">
                            <div className="flex items-center gap-3">
                              <span className="font-mono text-xs font-bold text-brand-pink bg-brand-pink/5 px-3 py-1 rounded-full flex items-center gap-1.5 border border-brand-pink/10 shadow-sm">
                                <Clock className="w-3.5 h-3.5" />
                                {formatTime12(b.time)}
                              </span>
                              <input 
                                type="time" 
                                value={b.time}
                                onChange={(e) => {
                                  const updated = [...blocks];
                                  updated[index].time = e.target.value;
                                  setBlocks(updated);
                                }}
                                className="text-xs font-mono bg-transparent text-brand-plum border-b border-dashed border-brand-pink/20 focus:outline-none focus:border-brand-pink p-0.5 transition-colors"
                              />
                            </div>
                            <div className="flex items-center gap-2">
                              <button
                                type="button"
                                onClick={() => {
                                  setMinimizedBlockIds(prev => {
                                    const next = new Set(prev);
                                    if (isMinimized) next.delete(b.id);
                                    else next.add(b.id);
                                    return next;
                                  });
                                }}
                                className="p-1.5 text-brand-plum/60 hover:text-brand-pink hover:bg-brand-pink/10 rounded-lg transition-all"
                                title={isMinimized ? "Expand" : "Minimize"}
                              >
                                {isMinimized ? <Maximize2 className="w-4 h-4" /> : <Minimize2 className="w-4 h-4" />}
                              </button>
                              <button
                                type="button"
                                onClick={() => {
                                  setBlocks(prev => prev.filter(item => item.id !== b.id));
                                }}
                                className="p-1.5 text-brand-rose/60 hover:text-brand-rose hover:bg-brand-rose/10 rounded-lg transition-all"
                                title="Delete moment"
                              >
                                <Trash2 className="w-4 h-4" />
                              </button>
                            </div>
                          </div>

                          {!isMinimized && (
                            <div className="bg-white/40 dark:bg-brand-bg/20 p-4 rounded-2xl border border-brand-border/30 shadow-sm hover:shadow-md transition-shadow flex flex-col gap-4">
                              <RichTextEditor
                                html={b.body}
                                onChange={(newHtml) => {
                                  const updated = [...blocks];
                                  updated[index].body = newHtml;
                                  setBlocks(updated);
                                }}
                                onFocus={() => setActiveBlockId(b.id)}
                                placeholder="Edit this moment's reflection..."
                                className={`rich-text-editor w-full text-lg leading-relaxed text-brand-plum focus:outline-none focus:ring-0 ${
                                  fontFamily === 'serif' ? 'font-serif-diary' : fontFamily === 'sans' ? 'font-sans' : 'font-mono'
                                }`}
                              />

                              {b.audioUri && (
                                <div className="border-t border-brand-border/20 pt-3 flex flex-col gap-2">
                                  <AudioWaveformPlayer 
                                    src={b.audioUri} 
                                    title={`Voice moment from ${formatTime12(b.time)}`}
                                    variant="minimal"
                                    onDelete={() => {
                                      const updated = [...blocks];
                                      updated[index].audioUri = undefined;
                                      setBlocks(updated);
                                    }}
                                  />

                                </div>
                              )}
                            </div>
                          )}
                        </div>
                      );
                    })}
                  </div>
                </div>
              )}

              {/* Single editing input card area for NEW moments */}
              <div className={`flex flex-col gap-3 flex-grow ${blocks.length > 0 ? 'border-t border-brand-pink/10 pt-4 mt-2' : ''}`}>
                <div className="flex items-center justify-between bg-brand-pink/5 px-3 py-1.5 rounded-xl border border-brand-pink/15">
                  <div className="flex items-center gap-1.5 select-none w-full">
                    <Clock className="w-3.5 h-3.5 text-brand-pink flex-shrink-0" />
                    <span className="text-[10px] font-bold text-brand-pink uppercase tracking-wider truncate">
                      Drafting Moment for {formatTime12(currentTimeText)}
                    </span>
                    <div className="ml-auto flex items-center">
                      <input 
                        type="time" 
                        value={currentTimeText}
                        onChange={(e) => setCurrentTimeText(e.target.value)}
                        className="text-[10px] font-mono bg-transparent text-brand-plum border-b border-dashed border-brand-pink/30 focus:outline-none focus:border-brand-pink p-0 cursor-pointer w-14"
                      />
                    </div>
                  </div>
                </div>

                <RichTextEditor
                  html={body}
                  onChange={setBody}
                  onFocus={() => setActiveBlockId(null)}
                  placeholder="Write a brand-new moment reflection for this hourly block..."
                  testId="entry-body-editor"
                  className={`rich-text-editor w-full text-lg leading-relaxed text-brand-plum focus:outline-none focus:ring-0 flex-grow min-h-[250px] ${
                    fontFamily === 'serif' ? 'font-serif-diary' : fontFamily === 'sans' ? 'font-sans' : 'font-mono'
                  }`}
                />

                {audioUri && (
                  <div className="mt-2 border-t border-brand-border/20 pt-4 flex flex-col items-center gap-2">
                    <AudioWaveformPlayer 
                      src={audioUri} 
                      variant="minimal"
                      onDelete={() => setAudioUri(undefined)}
                    />

                  </div>
                )}
              </div>
            </div>
          </div>

          {/* Floating Sticky Styling Controls at bottom of screen */}
          {isDockMinimized ? (
            <button
              onClick={() => setIsDockMinimized(false)}
              className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 px-4 py-2 bg-brand-card-bg/95 backdrop-blur-md text-brand-plum rounded-full border border-brand-border shadow-xl hover:scale-105 active:scale-95 transition-all flex items-center gap-1.5 text-xs font-bold animate-fade-in"
              title="Show Formatting Toolbar"
            >
              <Type className="w-4 h-4 text-brand-pink" />
              <span>Format</span>
              <ChevronUp className="w-3.5 h-3.5 ml-0.5 opacity-70" />
            </button>
          ) : (
            <div className="fixed bottom-6 left-1/2 -translate-x-1/2 z-50 bg-brand-card-bg/95 backdrop-blur-md px-4 py-2.5 rounded-2xl border border-brand-border shadow-xl flex items-center gap-1 transition-all">
              <button 
                type="button"
                onMouseDown={(e) => { e.preventDefault(); execCommand('bold'); }}
                className={`p-2 rounded-xl transition-all ${
                  activeFormats.bold 
                    ? 'bg-brand-pink text-white shadow-sm' 
                    : 'text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                }`}
                title="Bold"
              >
                <Bold className="w-4 h-4" />
              </button>
              <button 
                type="button"
                onMouseDown={(e) => { e.preventDefault(); execCommand('italic'); }}
                className={`p-2 rounded-xl transition-all ${
                  activeFormats.italic 
                    ? 'bg-brand-pink text-white shadow-sm' 
                    : 'text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                }`}
                title="Italic"
              >
                <Italic className="w-4 h-4" />
              </button>
              <button 
                type="button"
                onMouseDown={(e) => { e.preventDefault(); execCommand('underline'); }}
                className={`p-2 rounded-xl transition-all ${
                  activeFormats.underline 
                    ? 'bg-brand-pink text-white shadow-sm' 
                    : 'text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                }`}
                title="Underline"
              >
                <Underline className="w-4 h-4" />
              </button>
              <button 
                type="button"
                onMouseDown={(e) => { e.preventDefault(); execCommand('strikeThrough'); }}
                className={`p-2 rounded-xl transition-all ${
                  activeFormats.strikeThrough 
                    ? 'bg-brand-pink text-white shadow-sm' 
                    : 'text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                }`}
                title="Strikethrough"
              >
                <Strikethrough className="w-4 h-4" />
              </button>
              
              <div className="w-px h-5 bg-brand-border/50 mx-1" />

              <button 
                type="button"
                onMouseDown={(e) => { e.preventDefault(); toggleFormatBlock('h2'); }}
                className={`p-2 rounded-xl transition-all ${
                  activeFormats.h2 
                    ? 'bg-brand-pink text-white shadow-sm' 
                    : 'text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                }`}
                title="Heading style"
              >
                <Heading2 className="w-4 h-4" />
              </button>

              <button 
                type="button"
                onMouseDown={(e) => { e.preventDefault(); toggleFormatBlock('blockquote'); }}
                className={`p-2 rounded-xl transition-all ${
                  activeFormats.blockquote 
                    ? 'bg-brand-pink text-white shadow-sm' 
                    : 'text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                }`}
                title="Quote format"
              >
                <Quote className="w-4 h-4" />
              </button>

              <button 
                type="button"
                onMouseDown={(e) => { e.preventDefault(); execCommand('insertUnorderedList'); }}
                className={`p-2 rounded-xl transition-all ${
                  activeFormats.list 
                    ? 'bg-brand-pink text-white shadow-sm' 
                    : 'text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                }`}
                title="List format"
              >
                <List className="w-4 h-4" />
              </button>

              <div className="w-px h-5 bg-brand-border/50 mx-1" />

              <button 
                type="button"
                onMouseDown={(e) => { e.preventDefault(); toggleRecording('speech-to-text'); }}
                className={`p-2 rounded-xl transition-all ${
                  showRecordingOverlay && recordingOverlayMode === 'speech-to-text'
                    ? 'bg-red-100 text-red-500 shadow-sm' 
                    : 'text-brand-plum hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10'
                }`}
                title="Start Voice to Text"
              >
                <Mic className="w-4 h-4" />
              </button>

              <div className="w-px h-5 bg-brand-border/50 mx-1" />

              <button 
                type="button"
                onClick={() => setIsDockMinimized(true)}
                className="p-2 rounded-xl transition-all hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 text-brand-plum opacity-70 hover:opacity-100"
                title="Minimize Formatting"
              >
                <ChevronDown className="w-4 h-4" />
              </button>
            </div>
          )}

        </div>
        {localReflectionUI}
        {recordingOverlayUI}
      </div>
    );
  }

  if (layout === 'desktop') {
    return (
      <div className="space-y-6">
        <header className="flex flex-wrap items-center justify-between gap-5 xl:gap-6">
          <div className="min-w-0">
            <button
              type="button"
              onClick={onBack}
              className="inline-flex items-center gap-2 text-sm font-bold text-brand-sage transition-colors hover:text-brand-pink"
            >
              <ArrowLeft className="h-4 w-4" />
              My Journal
            </button>
            <h1 className="mt-2 font-serif-diary text-4xl font-semibold tracking-tight text-brand-plum dark:text-brand-text xl:text-5xl">
              {isEditing ? 'Edit Reflection' : 'New Entry'}
            </h1>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={onBack}
              className="rounded-full border border-brand-border bg-white/60 px-5 py-3 text-sm font-bold text-brand-sage transition-all hover:bg-white"
            >
              Discard
            </button>
            <button
              type="button"
              onClick={handleSave}
              disabled={isSaving}
              className="rounded-full bg-brand-sage px-6 py-3 text-sm font-bold text-white shadow-sm transition-all hover:bg-brand-sage-dark disabled:cursor-not-allowed disabled:opacity-55"
            >
              {isSaving ? 'Saving...' : 'Save Entry'}
            </button>
          </div>
        </header>

        <div className="grid grid-cols-1 gap-6 xl:grid-cols-[minmax(0,1fr)_320px] 2xl:grid-cols-[minmax(0,1fr)_340px] 2xl:gap-8">
          <main className="min-w-0 overflow-hidden rounded-[28px] border border-brand-border bg-white/86 shadow-[0_18px_60px_rgba(62,36,41,0.08)] dark:bg-brand-card-bg/82">
            <div className="sticky top-0 z-20 flex flex-wrap items-center justify-between gap-4 border-b border-brand-border bg-white/92 px-5 py-4 backdrop-blur-xl dark:bg-brand-card-bg/90 xl:px-7">
              <div className="flex flex-wrap items-center gap-1.5">
                {[
                  { key: 'bold', icon: Bold, action: () => execCommand('bold'), label: 'Bold' },
                  { key: 'italic', icon: Italic, action: () => execCommand('italic'), label: 'Italic' },
                  { key: 'underline', icon: Underline, action: () => execCommand('underline'), label: 'Underline' },
                  { key: 'strikeThrough', icon: Strikethrough, action: () => execCommand('strikeThrough'), label: 'Strikethrough' },
                ].map(item => {
                  const Icon = item.icon;
                  const active = Boolean(activeFormats[item.key as keyof typeof activeFormats]);
                  return (
                    <button
                      key={item.key}
                      type="button"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        item.action();
                      }}
                      className={`rounded-xl p-2 transition-all ${active ? 'bg-brand-pink text-white' : 'text-brand-plum hover:bg-brand-blush-light dark:text-brand-text'}`}
                      title={item.label}
                    >
                      <Icon className="h-4 w-4" />
                    </button>
                  );
                })}
                <span className="mx-2 h-6 w-px bg-brand-border" />
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    toggleFormatBlock('h2');
                  }}
                  className={`rounded-xl p-2 transition-all ${activeFormats.h2 ? 'bg-brand-pink text-white' : 'text-brand-plum hover:bg-brand-blush-light dark:text-brand-text'}`}
                  title="Heading"
                >
                  <Heading2 className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    toggleFormatBlock('blockquote');
                  }}
                  className={`rounded-xl p-2 transition-all ${activeFormats.blockquote ? 'bg-brand-pink text-white' : 'text-brand-plum hover:bg-brand-blush-light dark:text-brand-text'}`}
                  title="Quote"
                >
                  <Quote className="h-4 w-4" />
                </button>
                <button
                  type="button"
                  onMouseDown={(event) => {
                    event.preventDefault();
                    execCommand('insertUnorderedList');
                  }}
                  className={`rounded-xl p-2 transition-all ${activeFormats.list ? 'bg-brand-pink text-white' : 'text-brand-plum hover:bg-brand-blush-light dark:text-brand-text'}`}
                  title="List"
                >
                  <List className="h-4 w-4" />
                </button>
              </div>

              <div className="flex items-center gap-2 text-xs font-bold text-brand-text-muted">
                <span>{liveWordCount} words</span>
                <span className="h-2 w-2 rounded-full bg-brand-sage" />
                <span>Local draft</span>
              </div>
            </div>

            <section className="mx-auto max-w-4xl px-7 py-8 xl:px-10 xl:py-9 2xl:px-12 2xl:py-10">
              {showDiarySelector && diaries.length > 0 && (
                <label className="mb-7 flex flex-col gap-2">
                  <span className="text-xs font-bold uppercase tracking-[0.18em] text-brand-sage">Destination journal</span>
                  <select
                    value={diaryId}
                    onChange={(event) => setDiaryId(event.target.value)}
                    className="w-full rounded-xl border border-brand-border bg-brand-bg/55 px-4 py-3 text-sm font-bold text-brand-plum outline-none focus:border-brand-sage dark:text-brand-text"
                  >
                    {diaries.map(diary => (
                      <option key={diary.id} value={diary.id}>{diary.name}</option>
                    ))}
                  </select>
                </label>
              )}

              <div className="flex flex-wrap items-center justify-center gap-3 text-sm font-bold text-brand-text-muted">
                <input
                  type="date"
                  value={date}
                  onChange={(event) => setDate(event.target.value)}
                  className="rounded-full border border-brand-border bg-brand-bg/70 px-4 py-2 font-serif-diary text-brand-plum outline-none focus:border-brand-sage dark:text-brand-text"
                />
                <input
                  type="time"
                  value={time}
                  onChange={(event) => setTime(event.target.value)}
                  className="rounded-full border border-brand-border bg-brand-bg/70 px-4 py-2 font-serif-diary text-brand-plum outline-none focus:border-brand-sage dark:text-brand-text"
                />
                <select
                  value={mood.name}
                  onChange={(event) => {
                    const found = availableMoods.find(item => item.name === event.target.value);
                    if (found) setMood(found);
                  }}
                  className="rounded-full border border-brand-border bg-brand-bg/70 px-4 py-2 text-brand-plum outline-none focus:border-brand-sage dark:text-brand-text"
                >
                  {availableMoods.map(item => (
                    <option key={item.name} value={item.name}>{item.emoji} {item.name}</option>
                  ))}
                </select>
              </div>

              <input
                type="text"
                data-testid="entry-title-input"
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="Title of your reflection..."
                className={`mt-9 w-full border-none bg-transparent text-center text-4xl font-semibold tracking-tight text-brand-plum outline-none placeholder:text-brand-text-muted/30 dark:text-brand-text xl:text-[3rem] ${
                  fontFamily === 'serif' ? 'font-serif-diary' : fontFamily === 'sans' ? 'font-sans' : 'font-mono'
                }`}
              />

              <div className="mt-6 flex flex-wrap justify-center gap-2">
                {selectedTags.map(tag => (
                  <span key={tag} className="inline-flex items-center gap-2 rounded-full bg-brand-sage-light px-3 py-1.5 text-sm font-bold text-brand-sage-dark">
                    #{tag}
                    <button type="button" onClick={() => handleTagToggle(tag)} className="text-brand-sage-dark/65 hover:text-brand-rose">x</button>
                  </span>
                ))}
                <button
                  type="button"
                  onClick={() => setShowTagPicker(prev => !prev)}
                  className="inline-flex items-center gap-1 rounded-full border border-dashed border-brand-border px-3 py-1.5 text-sm font-bold text-brand-sage hover:border-brand-sage"
                >
                  <Plus className="h-3.5 w-3.5" />
                  Tag
                </button>
              </div>

              {showTagPicker && (
                <div className="mx-auto mt-4 flex max-h-32 max-w-2xl flex-wrap justify-center gap-2 overflow-y-auto rounded-2xl border border-brand-border bg-brand-bg/55 p-4">
                  {availableTags.map(tag => {
                    const isSelected = selectedTags.includes(tag);
                    return (
                      <button
                        key={tag}
                        type="button"
                        onClick={() => handleTagToggle(tag)}
                        className={`rounded-full px-3 py-1.5 text-xs font-bold transition-all ${isSelected ? 'bg-brand-pink text-white' : 'bg-white text-brand-sage-dark hover:bg-brand-sage-light'}`}
                      >
                        #{tag}
                      </button>
                    );
                  })}
                </div>
              )}

              <div className="mt-10 space-y-8">
                {blocks.length > 0 && (
                  <section className="space-y-5 border-b border-brand-border pb-8">
                    <p className="text-xs font-bold uppercase tracking-[0.18em] text-brand-pink">Saved Moments ({blocks.length})</p>
                    {blocks.map((block, index) => (
                      <div key={block.id} className="border-l-2 border-brand-pink/25 pl-6">
                        <div className="mb-3 flex items-center justify-between gap-3">
                          <input
                            type="time"
                            value={block.time}
                            onChange={(event) => {
                              const updated = [...blocks];
                              updated[index].time = event.target.value;
                              setBlocks(updated);
                            }}
                            className="rounded-full border border-brand-border bg-brand-bg/70 px-3 py-1 text-xs font-bold text-brand-plum outline-none"
                          />
                          <button
                            type="button"
                            onClick={() => setBlocks(prev => prev.filter(item => item.id !== block.id))}
                            className="rounded-full p-2 text-brand-rose hover:bg-red-50"
                            title="Delete moment"
                          >
                            <Trash2 className="h-4 w-4" />
                          </button>
                        </div>
                        <RichTextEditor
                          html={block.body}
                          onChange={(newHtml) => {
                            const updated = [...blocks];
                            updated[index].body = newHtml;
                            setBlocks(updated);
                          }}
                          onFocus={() => setActiveBlockId(block.id)}
                          placeholder="Edit moment..."
                          className={`rich-text-editor min-h-[120px] w-full text-xl leading-relaxed text-brand-plum outline-none dark:text-brand-text ${
                            fontFamily === 'serif' ? 'font-serif-diary' : fontFamily === 'sans' ? 'font-sans' : 'font-mono'
                          }`}
                        />
                        {block.audioUri && (
                          <div className="mt-4 max-w-md">
                            <AudioWaveformPlayer
                              src={block.audioUri}
                              title="Voice moment"
                              variant="minimal"
                              onDelete={() => {
                                const updated = [...blocks];
                                updated[index].audioUri = undefined;
                                setBlocks(updated);
                              }}
                            />
                          </div>
                        )}
                      </div>
                    ))}
                  </section>
                )}

                <section>
                  <div className="mb-4 inline-flex items-center gap-2 rounded-full bg-brand-pink/5 px-3 py-1 text-xs font-bold uppercase tracking-[0.16em] text-brand-pink">
                    <Clock className="h-3.5 w-3.5" />
                    Drafting Moment at {formatTime12(currentTimeText)}
                    <input
                      type="time"
                      value={currentTimeText}
                      onChange={(event) => setCurrentTimeText(event.target.value)}
                      className="ml-2 w-20 bg-transparent font-mono text-brand-plum outline-none"
                    />
                  </div>
                  <RichTextEditor
                    html={body}
                    onChange={setBody}
                    onFocus={() => setActiveBlockId(null)}
                    placeholder="Write a brand-new moment reflection..."
                    testId="entry-body-editor"
                    className={`rich-text-editor min-h-[360px] w-full text-2xl leading-[1.75] text-brand-plum outline-none dark:text-brand-text ${
                      fontFamily === 'serif' ? 'font-serif-diary' : fontFamily === 'sans' ? 'font-sans' : 'font-mono'
                    }`}
                  />
                  {audioUri && (
                    <div className="mt-5 max-w-md">
                      <AudioWaveformPlayer src={audioUri} variant="minimal" onDelete={() => setAudioUri(undefined)} />
                    </div>
                  )}
                </section>
              </div>
            </section>
          </main>

          <aside className="flex flex-col gap-5 xl:sticky xl:top-6 xl:max-h-[calc(100vh-5rem)] xl:overflow-y-auto">
            <section className="rounded-[24px] border border-brand-border bg-white/74 p-5 shadow-[0_14px_38px_rgba(62,36,41,0.07)] dark:bg-brand-card-bg/70">
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Scrapbook</h2>
                <button type="button" onClick={triggerPhotoInput} className="rounded-full border border-brand-border p-2 text-brand-sage hover:bg-brand-blush-light" title="Attach photo">
                  <Camera className="h-4 w-4" />
                </button>
              </div>
              <input type="file" ref={fileInputRef} onChange={handlePhotoUpload} multiple accept="image/*" className="hidden" />
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={triggerPhotoInput}
                  className="flex aspect-square flex-col items-center justify-center rounded-xl border border-dashed border-brand-border bg-brand-bg/50 text-xs font-bold uppercase tracking-wider text-brand-text-muted hover:border-brand-sage hover:text-brand-sage"
                >
                  <Camera className="mb-2 h-5 w-5" />
                  Drop photo
                </button>
                {photoUris.map((photo, index) => (
                  <div key={`${photo}-${index}`} className="relative aspect-square overflow-hidden rounded-xl border border-brand-border bg-brand-bg">
                    <SyncedImage src={photo} alt="" className="h-full w-full object-cover" label="entry photo" />
                    <button
                      type="button"
                      onClick={() => removePhoto(index)}
                      className="absolute right-1.5 top-1.5 rounded-full bg-black/60 p-1 text-white hover:bg-red-600"
                    >
                      <X className="h-3 w-3" />
                    </button>
                  </div>
                ))}
              </div>
            </section>

            <section className="rounded-[24px] border border-brand-border bg-white/74 p-5 shadow-sm dark:bg-brand-card-bg/70">
              <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-brand-plum dark:text-brand-text">Voice Memo</h2>
              <div className="mt-4 grid grid-cols-2 gap-3">
                <button
                  type="button"
                  onClick={() => toggleRecording('voice-dictation')}
                  className="rounded-2xl border border-brand-border bg-brand-bg/60 px-4 py-3 text-sm font-bold text-brand-sage hover:bg-brand-sage-light"
                >
                  Audio note
                </button>
                <button
                  type="button"
                  onClick={() => toggleRecording('speech-to-text')}
                  className="rounded-2xl border border-brand-border bg-brand-bg/60 px-4 py-3 text-sm font-bold text-brand-sage hover:bg-brand-sage-light"
                >
                  Dictate text
                </button>
              </div>
            </section>

            <section className="rounded-[24px] border border-brand-border bg-white/74 p-5 shadow-sm dark:bg-brand-card-bg/70">
              <h2 className="text-sm font-bold uppercase tracking-[0.18em] text-brand-sage">Local Reflection</h2>
              <p className="mt-2 text-sm leading-relaxed text-brand-text-muted">Private suggestions are generated on this device from your draft.</p>
              <button
                type="button"
                onClick={() => void handleAiEnhance()}
                disabled={aiLoading}
                className="mt-4 w-full rounded-full bg-brand-sage px-4 py-3 text-sm font-bold text-white disabled:opacity-50"
              >
                {aiLoading ? 'Reflecting...' : 'Suggest mood and tags'}
              </button>
              {aiError && <p className="mt-3 text-xs font-bold text-brand-rose">{aiError}</p>}
              {aiResult && (
                <div className="mt-4 rounded-2xl bg-brand-sage-light/35 p-4">
                  <p className="text-sm leading-relaxed text-brand-plum dark:text-brand-text">{aiResult.reflection}</p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <button type="button" onClick={() => applyAiMood(aiResult.mood)} className="rounded-full bg-brand-pink/10 px-3 py-1 text-xs font-bold text-brand-pink">
                      Use mood: {aiResult.mood}
                    </button>
                    {aiResult.tags.map(tag => (
                      <button key={tag} type="button" onClick={() => applyAiTag(tag)} className="rounded-full bg-brand-sage/10 px-3 py-1 text-xs font-bold text-brand-sage">
                        #{tag}
                      </button>
                    ))}
                  </div>
                </div>
              )}
            </section>

            <section className="rounded-[24px] border border-brand-border bg-white/62 p-5 shadow-sm dark:bg-brand-card-bg/55">
              <button
                type="button"
                onClick={() => {
                  setIsFocusMode(true);
                  setIsDockMinimized(true);
                  onFocusModeChange?.(true);
                }}
                className="inline-flex w-full items-center justify-center gap-2 rounded-full border border-brand-border bg-brand-bg/60 px-4 py-3 text-sm font-bold text-brand-sage hover:bg-brand-blush-light"
              >
                <Maximize2 className="h-4 w-4" />
                Focus mode
              </button>
            </section>
          </aside>
        </div>

        {isEditing && (
          <section className="max-w-4xl rounded-[24px] border border-red-100 bg-red-50/45 px-5 py-4">
            <p className="text-sm font-semibold text-red-700">Deleting this journal entry is irreversible.</p>
            {!showConfirmDelete ? (
              <button type="button" data-testid="entry-delete-button" onClick={() => setShowConfirmDelete(true)} className="mt-3 rounded-full border border-red-200 bg-white/65 px-4 py-2 text-sm font-bold text-red-700 hover:bg-red-100">
                Delete Entry
              </button>
            ) : (
              <div className="mt-3 flex gap-2">
                <button type="button" data-testid="entry-confirm-delete-button" onClick={handleDeleteEntry} className="rounded-full bg-red-600 px-4 py-2 text-sm font-bold text-white shadow-sm">
                  Confirm Delete
                </button>
                <button type="button" onClick={() => setShowConfirmDelete(false)} className="rounded-full border border-red-200 px-4 py-2 text-sm font-bold text-red-700">
                  Cancel
                </button>
              </div>
            )}
          </section>
        )}

        {recordingOverlayUI}
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-5 font-sans relative pb-28">
      {/* Top Header */}
      <header className="flex justify-between items-center bg-brand-bg sticky top-0 py-3 z-30 border-b border-brand-rose-light/40">
        <button 
          onClick={onBack}
          className="p-2 text-brand-plum hover:bg-brand-blush-light rounded-full transition-all active:scale-90"
        >
          <X className="w-5 h-5" />
        </button>
        <div className="flex items-center gap-3">
          <button 
            onClick={onBack}
            className="px-4 py-2 font-bold text-xs text-brand-sage hover:text-brand-plum transition-colors"
          >
            Discard
          </button>
          <button 
            onClick={handleSave}
            disabled={isSaving}
            className="bg-brand-sage hover:bg-brand-sage-dark text-white px-5 py-2 rounded-full text-xs font-bold transition-all active:scale-95 shadow-sm disabled:cursor-not-allowed disabled:opacity-60"
          >
            {isSaving ? 'Saving...' : 'Save Entry'}
          </button>
        </div>
      </header>

      {/* Unified Writing Canvas */}
      <div className="bg-brand-card-bg p-4 md:p-5 rounded-3xl journal-shadow border border-brand-border flex flex-col gap-3 flex-grow">
        
        {showDiarySelector && diaries.length > 0 && (
          <div className="flex flex-col gap-1.5 pb-3 border-b border-brand-border/20">
            <label className="text-[10px] font-extrabold text-brand-pink uppercase tracking-widest pl-0.5 select-none">
              Choose Destination Journal
            </label>
            <div className="relative">
              <select
                value={diaryId}
                onChange={(e) => setDiaryId(e.target.value)}
                className="absolute inset-0 opacity-0 cursor-pointer z-10 w-full h-full"
              >
                {diaries.map(d => (
                  <option key={d.id} value={d.id}>
                    {d.name}
                  </option>
                ))}
              </select>
              <div className="flex items-center justify-between px-3.5 py-2.5 rounded-xl border border-brand-border/60 bg-brand-bg/30 text-brand-plum text-xs font-semibold hover:border-brand-pink/30 hover:bg-brand-blush-light/15 transition-all shadow-inner">
                <div className="flex items-center gap-2 overflow-hidden select-none">
                  <span 
                    className="w-3 h-3 rounded-full shadow-md border border-white/20 flex-shrink-0" 
                    style={{ backgroundColor: diaries.find(d => d.id === diaryId)?.color || '#8A3D55' }}
                  />
                  <span className="font-serif-diary italic text-sm truncate pr-1">
                    {diaries.find(d => d.id === diaryId)?.name || 'Select a Journal'}
                  </span>
                </div>
                <ChevronDown className="w-3.5 h-3.5 text-brand-sage flex-shrink-0" />
              </div>
            </div>
          </div>
        )}

        {/* Modern Inline Metadata Ribbon */}
        <div className="flex flex-wrap items-center gap-2 text-xs text-brand-sage/80 border-b border-brand-border/20 pb-2 mb-1 select-none">
          {/* Inline Date Field */}
          <div className="flex items-center gap-1 hover:text-brand-pink transition-colors cursor-pointer">
            <Calendar className="w-3.5 h-3.5 text-brand-pink" />
            <input 
              type="date" 
              value={date}
              onChange={(e) => setDate(e.target.value)}
              className="bg-transparent border-none text-brand-plum font-serif-diary font-bold py-0 p-0 focus:outline-none focus:ring-0 cursor-pointer w-[105px]"
            />
          </div>

          <span className="text-brand-border/60">•</span>

          {/* Inline Time Field */}
          <div className="flex items-center gap-1 hover:text-brand-pink transition-colors cursor-pointer">
            <Clock className="w-3.5 h-3.5 text-brand-pink" />
            <input 
              type="time" 
              value={time}
              onChange={(e) => setTime(e.target.value)}
              className="bg-transparent border-none text-brand-plum font-serif-diary font-bold py-0 p-0 focus:outline-none focus:ring-0 cursor-pointer w-[65px]"
            />
          </div>

          <span className="text-brand-border/60">•</span>

          {/* Word Count */}
          <div className="text-[11px] font-semibold text-brand-sage/80 bg-brand-rose-light/40 dark:bg-brand-rose-light/10 px-2 py-0.5 rounded-md border border-brand-border/20">
            {liveWordCount} words
          </div>
        </div>

        {/* Title Input */}
        <div className="w-full">
          <input 
            type="text" 
            data-testid="entry-title-input"
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            placeholder="Title your entry..."
            className={`w-full bg-transparent p-0 border-none text-base md:text-lg font-bold text-brand-plum placeholder-brand-sage/35 focus:outline-none focus:ring-0 pb-1 border-b border-brand-border/15 focus:border-brand-pink/40 transition-colors ${
              fontFamily === 'serif' ? 'font-serif-diary' : fontFamily === 'sans' ? 'font-sans' : 'font-mono'
            }`}
          />
        </div>

        {/* Cohesive Inline Mood & Tags Row */}
        <div className="flex flex-wrap items-center gap-2 border-b border-brand-border/20 pb-2.5 mb-1.5">
          {/* Active Mood Button with overlay dropdown */}
          <div className="relative">
            <select
              value={mood.name}
              onChange={(e) => {
                const found = availableMoods.find(m => m.name === e.target.value);
                if (found) setMood(found);
              }}
              className="absolute inset-0 opacity-0 cursor-pointer z-10 w-full h-full"
            >
              {availableMoods.map(m => (
                <option key={m.name} value={m.name}>{m.emoji} {m.name}</option>
              ))}
            </select>
            <button
              type="button"
              className="flex items-center gap-1.5 px-2.5 py-1 rounded-full border border-brand-border bg-white dark:bg-brand-card-bg text-brand-plum text-[11px] font-semibold hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 transition-all shadow-sm"
            >
              <span>{mood.emoji}</span>
              <span>Feeling {mood.name}</span>
              <ChevronDown className="w-3 h-3 text-brand-sage/80" />
            </button>
          </div>

          {selectedTags.length > 0 && <span className="text-brand-border/40 font-light">|</span>}

          {/* Active Tags list */}
          <div className="flex flex-wrap items-center gap-1.5">
            {selectedTags.map(tag => (
              <span 
                key={tag}
                className="text-[10px] font-semibold text-brand-pink bg-brand-pink/5 px-2 py-0.5 rounded-full border border-brand-pink/15 flex items-center gap-1"
              >
                #{tag}
                <button 
                  type="button" 
                  onClick={() => handleTagToggle(tag)} 
                  className="hover:text-red-500 font-extrabold ml-1 leading-none text-xs text-brand-pink/60 hover:text-brand-rose transition-colors"
                  title="Remove tag"
                >
                  ×
                </button>
              </span>
            ))}
            <button
              type="button"
              onClick={() => setShowTagPicker(true)}
              className="flex items-center gap-1 text-[10px] font-bold text-brand-sage hover:text-brand-pink px-2 py-0.5 rounded-full border border-dashed border-brand-border/60 bg-transparent hover:border-brand-pink/40 transition-all cursor-pointer"
            >
              <Plus className="w-2.5 h-2.5 text-brand-pink" />
              <span>Tag</span>
            </button>
          </div>
        </div>

        {/* Content Canvas (Timelines, text body inputs) */}
        <div className="flex flex-col gap-2.5 flex-grow mt-1">
          
          {/* Editor Header controls inline */}
          <div className="flex justify-between items-center pb-1 text-brand-sage select-none">
            <div className="flex items-center gap-1">
              <button
                type="button"
                onClick={() => setFontFamily(prev => prev === 'serif' ? 'sans' : prev === 'sans' ? 'mono' : 'serif')}
                className="px-2 py-1 rounded-lg bg-brand-bg/40 hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 text-[11px] font-bold transition-all flex items-center gap-1 text-brand-plum border border-brand-border/40 active:scale-95"
                title="Change Writing Font style"
              >
                <Type className="w-3 h-3 text-brand-pink" />
                <span>Font: <span className="capitalize">{fontFamily}</span></span>
              </button>
            </div>

            <div className="flex items-center gap-1.5">
              <button
                type="button"
                onClick={() => toggleRecording('voice-dictation')}
                className="px-2 py-1 rounded-lg bg-brand-bg/40 hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 text-[11px] font-bold transition-all flex items-center gap-1 text-brand-plum border border-brand-border/40 active:scale-95"
                title="Record Voice Note"
              >
                <Mic className="w-3 h-3 text-brand-pink" />
                <span>Voice Note</span>
              </button>

              <button
                type="button"
                onClick={() => toggleRecording('speech-to-text')}
                className={`px-2 py-1 rounded-lg hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 text-[11px] font-bold transition-all flex items-center gap-1 border border-brand-border/40 active:scale-95 ${
                  showRecordingOverlay && recordingOverlayMode === 'speech-to-text'
                    ? 'bg-red-100 text-red-500'
                    : 'bg-brand-bg/40 text-brand-plum'
                }`}
                title="Start Voice to Text"
              >
                <Edit className="w-3 h-3 text-brand-pink" />
                <span>Voice Text</span>
              </button>

              <button
                type="button"
                onClick={() => {
                  setIsFocusMode(true);
                  setIsDockMinimized(true);
                  onFocusModeChange?.(true);
                }}
                className="px-2 py-1 rounded-lg bg-brand-bg/40 hover:bg-brand-blush-light dark:hover:bg-brand-blush-light/10 text-[11px] font-bold transition-all flex items-center gap-1 text-brand-plum border border-brand-border/40 active:scale-95"
                title="Distraction-free Writing Mode"
              >
                <Maximize2 className="w-3 h-3 text-brand-pink animate-pulse" />
                <span>Focus</span>
              </button>
            </div>
          </div>

          <div className="flex flex-col gap-5 text-left w-full h-full mt-2">
            {/* List of blocks in edit mode for mobile */}
            {blocks.length > 0 && (
              <div className="flex flex-col gap-5 mb-4">
                <span className="text-[10px] font-extrabold text-brand-pink uppercase tracking-wider pl-1 border-b border-brand-pink/10 pb-1.5">
                  Saved Moments ({blocks.length})
                </span>
                <div className="flex flex-col gap-5 animate-fade-in">
                  {blocks.map((b, index) => {
                    const isMinimized = minimizedBlockIds.has(b.id);
                    return (
                      <div 
                        key={b.id} 
                        className="relative pl-6 border-l-2 border-brand-pink/20 flex flex-col gap-2 group"
                      >
                        {/* Timeline point */}
                        <div className="absolute -left-[5px] top-1.5 w-2 h-2 rounded-full bg-brand-bg border-2 border-brand-pink group-hover:scale-110 transition-transform" />
                        
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2 overflow-hidden">
                            <span className="font-mono text-[10px] font-bold text-brand-pink bg-brand-pink/5 px-2 py-0.5 rounded flex items-center gap-1 border border-brand-pink/10 shadow-sm">
                              <Clock className="w-3.5 h-3.5" />
                              {formatTime12(b.time)}
                            </span>
                            <input 
                              type="time" 
                              value={b.time}
                              onChange={(e) => {
                                const updated = [...blocks];
                                updated[index].time = e.target.value;
                                setBlocks(updated);
                              }}
                              className="text-[10px] font-mono bg-transparent text-brand-plum border-b border-dashed border-brand-pink/20 focus:outline-none focus:border-brand-pink p-0 transition-colors w-20 cursor-pointer"
                            />
                          </div>
                          <div className="flex items-center gap-1">
                            <button
                              type="button"
                              onClick={() => {
                                setMinimizedBlockIds(prev => {
                                  const next = new Set(prev);
                                  if (isMinimized) next.delete(b.id);
                                  else next.add(b.id);
                                  return next;
                                });
                              }}
                              className="p-1 text-brand-plum/60 hover:text-brand-pink hover:bg-brand-pink/10 rounded"
                            >
                              {isMinimized ? <Maximize2 className="w-3.5 h-3.5" /> : <Minimize2 className="w-3.5 h-3.5" />}
                            </button>
                            <button
                              type="button"
                              onClick={() => {
                                setBlocks(prev => prev.filter(item => item.id !== b.id));
                              }}
                              className="p-1 text-brand-rose/60 hover:text-brand-rose hover:bg-brand-rose/10 rounded"
                              title="Delete moment"
                            >
                              <Trash2 className="w-3.5 h-3.5" />
                            </button>
                          </div>
                        </div>

                        {!isMinimized && (
                          <div className="bg-white/45 dark:bg-brand-bg/25 p-3 rounded-xl border border-brand-border/20 flex flex-col gap-3 shadow-inner">
                            <RichTextEditor
                              html={b.body}
                              onChange={(newHtml) => {
                                const updated = [...blocks];
                                updated[index].body = newHtml;
                                setBlocks(updated);
                              }}
                              onFocus={() => setActiveBlockId(b.id)}
                              placeholder="Edit moment..."
                              className={`rich-text-editor w-full text-base leading-relaxed text-brand-plum focus:outline-none focus:ring-0 ${
                                fontFamily === 'serif' ? 'font-serif-diary' : fontFamily === 'sans' ? 'font-sans' : 'font-mono'
                              }`}
                            />

                            {b.audioUri && (
                              <div className="border-t border-brand-border/10 pt-2 flex flex-col gap-2">
                                <AudioWaveformPlayer 
                                  src={b.audioUri} 
                                  title={`Voice moment`}
                                  variant="minimal"
                                  onDelete={() => {
                                    const updated = [...blocks];
                                    updated[index].audioUri = undefined;
                                    setBlocks(updated);
                                  }}
                                />
                              </div>
                            )}
                          </div>
                        )}
                      </div>
                    );
                  })}
                </div>
              </div>
            )}

            {/* New Moment drafting area */}
            <div className={`flex flex-col gap-2.5 flex-grow ${blocks.length > 0 ? 'border-t border-brand-pink/10 pt-3' : ''}`}>
              <div className="flex items-center justify-between bg-brand-pink/5 px-2.5 py-1 rounded-xl border border-brand-pink/15">
                <div className="flex items-center gap-1.5 select-none overflow-hidden w-full">
                  <Clock className="w-3.5 h-3.5 text-brand-pink flex-shrink-0" />
                  <span className="text-[10px] font-bold text-brand-pink uppercase tracking-wider truncate">
                    Drafting Moment at {formatTime12(currentTimeText)}
                  </span>
                  <div className="ml-auto flex items-center">
                    <input 
                      type="time" 
                      value={currentTimeText}
                      onChange={(e) => setCurrentTimeText(e.target.value)}
                      className="ml-1 text-[10px] font-mono bg-transparent text-brand-plum border-b border-dashed border-brand-pink/30 focus:outline-none focus:border-brand-pink p-0 cursor-pointer w-14"
                    />
                  </div>
                </div>
              </div>

              <RichTextEditor
                html={body}
                onChange={setBody}
                onFocus={() => setActiveBlockId(null)}
                placeholder="Write a brand-new moment reflection..."
                testId="entry-body-editor"
                className={`rich-text-editor w-full text-base leading-relaxed text-brand-plum min-h-[180px] focus:outline-none focus:ring-0 ${
                  fontFamily === 'serif' ? 'font-serif-diary' : fontFamily === 'sans' ? 'font-sans' : 'font-mono'
                }`}
              />

              {audioUri && (
                <div className="mt-2 border-t border-brand-border/10 pt-3 flex flex-col items-center gap-2">
                  <AudioWaveformPlayer 
                    src={audioUri} 
                    variant="minimal"
                    onDelete={() => setAudioUri(undefined)}
                  />
                </div>
              )}
            </div>
          </div>
        </div>

        {/* Thumbnail attachments list */}
        {photoUris.length > 0 && (
          <div className="flex flex-col gap-1.5 border-t border-brand-border/40 pt-3 mt-2">
            <p className="text-[10px] font-bold text-brand-sage uppercase tracking-widest">
              Attached Photos
            </p>
            <div className="flex overflow-x-auto gap-3 py-1">
              {photoUris.map((photo, idx) => (
                <div key={idx} className="relative w-20 h-20 rounded-xl overflow-hidden shadow-sm border border-brand-rose-light flex-shrink-0">
                  <SyncedImage
                    src={photo}
                    alt=""
                    className="w-full h-full object-cover"
                    label="entry photo"
                  />
                  <button
                    type="button"
                    onClick={() => removePhoto(idx)}
                    className="absolute top-1 right-1 p-1 bg-black/60 backdrop-blur-sm text-white rounded-full hover:bg-red-600 transition-colors"
                  >
                    <X className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>



      {/* Styles formatting toolbar (Inline for normal mode) */}
      <div className="mt-4 mb-16 bg-brand-card-bg/50 border border-brand-border/60 shadow-sm rounded-2xl p-2 transition-all">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex flex-wrap items-center gap-1">
            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); execCommand('bold'); }}
              className={`p-2 rounded-xl transition-all ${
                activeFormats.bold 
                  ? 'bg-brand-pink text-white shadow-sm' 
                  : 'text-brand-sage hover:bg-brand-blush-light'
              }`}
              title="Bold"
            >
              <Bold className="w-4 h-4" />
            </button>
            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); execCommand('italic'); }}
              className={`p-2 rounded-xl transition-all ${
                activeFormats.italic 
                  ? 'bg-brand-pink text-white shadow-sm' 
                  : 'text-brand-sage hover:bg-brand-blush-light'
              }`}
              title="Italic"
            >
              <Italic className="w-4 h-4" />
            </button>
            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); execCommand('underline'); }}
              className={`p-2 rounded-xl transition-all ${
                activeFormats.underline 
                  ? 'bg-brand-pink text-white shadow-sm' 
                  : 'text-brand-sage hover:bg-brand-blush-light'
              }`}
              title="Underline"
            >
              <Underline className="w-4 h-4" />
            </button>
            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); execCommand('strikeThrough'); }}
              className={`p-2 rounded-xl transition-all ${
                activeFormats.strikeThrough 
                  ? 'bg-brand-pink text-white shadow-sm' 
                  : 'text-brand-sage hover:bg-brand-blush-light'
              }`}
              title="Strikethrough"
            >
              <Strikethrough className="w-4 h-4" />
            </button>
            
            <div className="w-px h-6 bg-brand-rose-light mx-1" />

            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); toggleFormatBlock('h2'); }}
              className={`p-2 rounded-xl transition-all ${
                activeFormats.h2 
                  ? 'bg-brand-pink text-white shadow-sm' 
                  : 'text-brand-sage hover:bg-brand-blush-light'
              }`}
              title="Heading style"
            >
              <Heading2 className="w-4 h-4" />
            </button>
            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); toggleFormatBlock('blockquote'); }}
              className={`p-2 rounded-xl transition-all ${
                activeFormats.blockquote 
                  ? 'bg-brand-pink text-white shadow-sm' 
                  : 'text-brand-sage hover:bg-brand-blush-light'
              }`}
              title="Quote format"
            >
              <Quote className="w-4 h-4" />
            </button>
            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); execCommand('insertUnorderedList'); }}
              className={`p-2 rounded-xl transition-all ${
                activeFormats.list 
                  ? 'bg-brand-pink text-white shadow-sm' 
                  : 'text-brand-sage hover:bg-brand-blush-light'
              }`}
              title="List format"
            >
              <List className="w-4 h-4" />
            </button>
          </div>

          <div className="flex items-center gap-1.5">
            {/* Voice to text Button */}
            <button 
              type="button"
              onMouseDown={(e) => { e.preventDefault(); toggleRecording('speech-to-text'); }}
              className={`p-2 rounded-xl transition-all relative ${
                showRecordingOverlay && recordingOverlayMode === 'speech-to-text'
                  ? 'bg-red-100 text-red-500 shadow-sm' 
                  : 'text-brand-sage hover:bg-brand-blush-light'
              }`}
              title="Start Voice to Text"
            >
              <Mic className="w-4 h-4" />
            </button>

            {/* Attachment Button */}
            <button 
              type="button"
              onClick={triggerPhotoInput}
              className="p-2 text-brand-sage hover:bg-brand-blush-light rounded-xl relative"
              title="Attach photo from library"
            >
              <Camera className="w-4 h-4" />
            </button>
            
            {/* Tag Selection Trigger Toggle */}
            <button 
              type="button"
              onClick={() => setShowTagPicker(!showTagPicker)}
              className={`p-2 rounded-xl transition-all ${showTagPicker ? 'bg-brand-pink text-white' : 'text-brand-sage hover:bg-brand-blush-light'}`}
            >
              <Tag className="w-4 h-4" />
            </button>

            {/* Hidden Photo File uploader input */}
            <input 
              type="file" 
              ref={fileInputRef}
              onChange={handlePhotoUpload}
              multiple
              accept="image/*"
              className="hidden"
            />
          </div>
        </div>
      </div>

      {/* Floating Tag Selection Picker Overlay */}
      <AnimatePresence>
        {showTagPicker && (
          <motion.div 
            initial={{ y: 20, opacity: 0 }}
            animate={{ y: 0, opacity: 1 }}
            exit={{ y: 20, opacity: 0 }}
            className="fixed bottom-24 left-0 right-0 p-4 bg-brand-card-bg/95 backdrop-blur-md border-t border-brand-border shadow-lg rounded-t-3xl z-40 mobile-overlay-safe"
          >
            <div className="max-w-md mx-auto flex flex-col gap-3">
              <div className="flex justify-between items-center">
                <span className="text-xs font-bold text-brand-sage uppercase tracking-widest">Select Diary Tags</span>
                <button onClick={() => setShowTagPicker(false)} className="text-brand-sage">
                  <X className="w-4 h-4" />
                </button>
              </div>
              <div className="flex flex-wrap gap-2 py-2 max-h-40 overflow-y-auto no-scrollbar">
                {availableTags.map(tag => {
                  const isSelected = selectedTags.includes(tag);
                  return (
                    <button
                      key={tag}
                      type="button"
                      onClick={() => handleTagToggle(tag)}
                      className={`px-3 py-1.5 rounded-full text-xs font-semibold transition-all ${
                        isSelected 
                          ? 'bg-brand-pink text-white border-2 border-brand-pink shadow-sm scale-105' 
                          : 'bg-brand-bg text-brand-sage-dark border border-brand-border hover:bg-brand-rose-light/40'
                      }`}
                    >
                      #{tag}
                    </button>
                  );
                })}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* Delete Entry Danger Confirmation Zone when editing */}
      {isEditing && (
        <div className="bg-red-50/50 p-5 rounded-3xl border border-red-100 flex flex-col gap-3 mt-4">
          <p className="text-xs text-red-600/90 leading-relaxed">
            Need to clear this reflection? Deleting this journal entry is irreversible.
          </p>

          {!showConfirmDelete ? (
            <button
              data-testid="entry-delete-button"
              onClick={() => setShowConfirmDelete(true)}
              className="py-2.5 rounded-xl bg-red-100 hover:bg-red-200 text-red-700 text-xs font-bold transition-all flex items-center justify-center gap-1.5"
            >
              <Trash2 className="w-4 h-4" />
              Delete Entry
            </button>
          ) : (
            <div className="flex gap-2">
              <button
                type="button"
                onClick={() => setShowConfirmDelete(false)}
                className="flex-grow py-2 bg-brand-card-bg border border-red-200 text-red-700 rounded-xl text-xs font-bold"
              >
                Cancel
              </button>
              <button
                type="button"
                data-testid="entry-confirm-delete-button"
                onClick={handleDeleteEntry}
                className="flex-grow py-2 bg-red-600 hover:bg-red-700 text-white rounded-xl text-xs font-bold transition-colors"
              >
                Yes, Delete entry
              </button>
            </div>
          )}
        </div>
      )}

      {localReflectionUI}
      {recordingOverlayUI}
    </div>
  );
}
