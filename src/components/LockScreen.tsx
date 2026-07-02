import React, { useState, useEffect } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { 
  Lock, Fingerprint, BookOpen, ShieldCheck, Check, Delete, 
  KeyRound, Eye, EyeOff, Sparkles, Sun, Moon, ArrowLeft, 
  AlertCircle, RefreshCw 
} from 'lucide-react';
import { getSecurityConfig, setPinCode, verifyPinCode, resetPinCode, getAppSettings, saveAppSettings } from '../utils/storage';
import { auth } from '../utils/firebase';
import { signInWithPopup, GoogleAuthProvider } from 'firebase/auth';
import { SecurityConfig } from '../types';
import { secureAuthService } from '../platform/security';

interface LockScreenProps {
  onUnlock: () => void;
}

const SANCTUARY_QUOTES = [
  "Your thoughts deserve a safe, quiet space.",
  "Give yourself grace for the things left undone.",
  "In the garden of your mind, let peace grow.",
  "Write what is in your heart; it is always true.",
  "Savor the simple, beautiful, quiet moments.",
  "A diary is a mirror of your beautiful soul.",
  "Breathe in calm, breathe out the noise of the world.",
  "Every page is a fresh start. Every word is a step home.",
  "Quiet your mind. Let your pen find its own way."
];

const KEY_LETTERS: { [key: string]: string } = {
  '1': ' ',
  '2': 'A B C',
  '3': 'D E F',
  '4': 'G H I',
  '5': 'J K L',
  '6': 'M N O',
  '7': 'P Q R S',
  '8': 'T U V',
  '9': 'W X Y Z',
  '0': '+'
};

export default function LockScreen({ onUnlock }: LockScreenProps) {
  const [security, setSecurity] = useState<SecurityConfig>(getSecurityConfig());
  const [pin, setPin] = useState<string>('');
  const [confirmPin, setConfirmPin] = useState<string>('');
  const [isConfirming, setIsConfirming] = useState<boolean>(false);
  const [error, setError] = useState<string>('');
  const [successMsg, setSuccessMsg] = useState<string>('');
  const [isBiometricActive, setIsBiometricActive] = useState<boolean>(false);
  const [showPin, setShowPin] = useState<boolean>(false);
  const [shakeTrigger, setShakeTrigger] = useState<boolean>(false);
  const [isResetting, setIsResetting] = useState<boolean>(false);
  const [resetOption, setResetOption] = useState<'choosing' | 'google' | 'local' | null>(null);

  // High-fidelity local states
  const [screenMode, setScreenMode] = useState<'ambient' | 'keypad'>(() => {
    const config = getSecurityConfig();
    return config.isPinCreated ? 'ambient' : 'keypad'; // Setup mode directly goes to Keypad
  });

  const [time, setTime] = useState<string>('');
  const [date, setDate] = useState<string>('');
  const [quoteIndex, setQuoteIndex] = useState<number>(0);
  const [isSuccessUnlocked, setIsSuccessUnlocked] = useState<boolean>(false);

  const [theme, setTheme] = useState<'light' | 'dark'>(() => {
    const settings = getAppSettings();
    return settings.theme || 'light';
  });

  // Clock / Date Tracker
  useEffect(() => {
    const updateTime = () => {
      const now = new Date();
      let hours = now.getHours();
      let minutes = String(now.getMinutes()).padStart(2, '0');
      setTime(`${hours}:${minutes}`);

      const options: Intl.DateTimeFormatOptions = { 
        weekday: 'long', 
        month: 'long', 
        day: 'numeric' 
      };
      setDate(now.toLocaleDateString(undefined, options));
    };

    updateTime();
    const interval = setInterval(updateTime, 1000);
    return () => clearInterval(interval);
  }, []);

  // Quotes Auto Rotator
  useEffect(() => {
    const quoteInterval = setInterval(() => {
      setQuoteIndex(prev => (prev + 1) % SANCTUARY_QUOTES.length);
    }, 12000);
    return () => clearInterval(quoteInterval);
  }, []);

  // Auto unlock with simulated biometrics on startup if enabled
  useEffect(() => {
    if (security.isPinCreated && security.isBiometricsEnabled && security.isBiometricsSimulated) {
      const timer = setTimeout(() => {
        handleBiometricUnlock();
      }, 1000);
      return () => clearTimeout(timer);
    }
  }, [security.isPinCreated, security.isBiometricsEnabled, security.isBiometricsSimulated]);

  // Synchronize document.documentElement class list with active theme state on mount or changes
  useEffect(() => {
    if (theme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
  }, [theme]);

  const triggerHaptic = (pattern: number | number[]) => {
    if (typeof window !== 'undefined' && window.navigator && typeof window.navigator.vibrate === 'function') {
      try {
        window.navigator.vibrate(pattern);
      } catch (e) {
        console.warn('Haptic feedback not supported on this platform/device:', e);
      }
    }
  };

  const handleKeyPress = (num: string) => {
    triggerHaptic(10);
    if (pin.length < 8) {
      setError('');
      setPin(prev => prev + num);
    }
  };

  const handleBackspace = () => {
    triggerHaptic(12);
    setPin(prev => prev.slice(0, -1));
  };

  const handleClear = () => {
    triggerHaptic(20);
    setPin('');
    setError('');
  };

  const handleBiometricUnlock = async () => {
    triggerHaptic(15);
    setIsBiometricActive(true);
    setError('');
    
    if (security.isBiometricsSimulated) {
      setSuccessMsg('Verifying fingerprint...');
      setTimeout(() => {
        triggerHaptic(30);
        setSuccessMsg('Biometrics verified successfully');
        setIsSuccessUnlocked(true);
        setTimeout(() => {
          onUnlock();
        }, 500);
      }, 1200);
    } else {
      setSuccessMsg('Initializing secure credential authorization...');
      try {
        const success = await secureAuthService.authenticate(security.passkeyCredentialId);
        if (success) {
          triggerHaptic(40);
          setSuccessMsg('Passkey verified successfully!');
          setIsSuccessUnlocked(true);
          setTimeout(() => {
            onUnlock();
          }, 500);
        } else {
          setError('Authentication did not return validation.');
          triggerHaptic([50, 50, 50]);
          setIsBiometricActive(false);
          setSuccessMsg('');
        }
      } catch (err: any) {
        console.warn('WebAuthn Authentication Error:', err);
        if (err?.name === 'NotAllowedError') {
          setError('Credential dialog closed. Use PIN.');
        } else {
          setError(err?.message || 'Biometric authenticator failed.');
        }
        triggerHaptic([50, 50, 50]);
        setIsBiometricActive(false);
        setSuccessMsg('');
      }
    }
  };

  const handleForgotPassword = async (option: 'google' | 'local') => {
    try {
      setIsResetting(true);
      setError('');
      setSuccessMsg(`Resetting PIN via ${option === 'google' ? 'Google' : 'Local'}...`);
      
      if (option === 'google') {
        const provider = new GoogleAuthProvider();
        await signInWithPopup(auth, provider);
      }
      
      const newConfig = resetPinCode();
      setSecurity(newConfig);
      setSuccessMsg('Security reset successfully. Please set a new PIN.');
      setIsConfirming(false);
      setPin('');
      setConfirmPin('');
      setIsResetting(false);
      setResetOption(null);
      setScreenMode('keypad'); // Force setup mode
    } catch (err) {
      console.error(err);
      setError(`Failed to reset PIN. Please try again.`);
      setIsResetting(false);
      setSuccessMsg('');
      setResetOption(null);
    }
  };

  const handleSubmit = (e?: React.FormEvent) => {
    if (e) e.preventDefault();

    if (pin.length < 4) {
      setError('PIN must be at least 4 digits');
      setShakeTrigger(true);
      triggerHaptic([60, 40, 60]);
      setTimeout(() => setShakeTrigger(false), 500);
      return;
    }

    if (!security.isPinCreated) {
      // Setup PIN Mode
      if (!isConfirming) {
        triggerHaptic(25);
        setConfirmPin(pin);
        setPin('');
        setIsConfirming(true);
      } else {
        if (pin === confirmPin) {
          triggerHaptic([30, 80, 40]);
          const newConfig = setPinCode(pin);
          setSecurity(newConfig);
          setSuccessMsg('Private diary PIN configured!');
          setIsSuccessUnlocked(true);
          setTimeout(() => {
            onUnlock();
          }, 800);
        } else {
          setError('PINs do not match. Restarting setup.');
          setShakeTrigger(true);
          triggerHaptic([60, 40, 60, 40, 60]);
          setTimeout(() => setShakeTrigger(false), 500);
          setPin('');
          setIsConfirming(false);
          setConfirmPin('');
        }
      }
    } else {
      // Login Mode
      const isCorrect = verifyPinCode(pin);
      if (isCorrect) {
        triggerHaptic([40, 40]);
        setSuccessMsg('Access Granted');
        setIsSuccessUnlocked(true);
        setTimeout(() => {
          onUnlock();
        }, 500);
      } else {
        setError('Incorrect security PIN');
        setShakeTrigger(true);
        triggerHaptic([60, 40, 60]);
        setTimeout(() => setShakeTrigger(false), 500);
        setPin('');
      }
    }
  };

  // Watch PIN entry for auto-submission of 4-digit PINs if in login mode
  useEffect(() => {
    if (security.isPinCreated && pin.length === 4) {
      const isCorrect = verifyPinCode(pin);
      if (isCorrect) {
        triggerHaptic([40, 40]);
        setSuccessMsg('Access Granted');
        setIsSuccessUnlocked(true);
        setTimeout(() => {
          onUnlock();
        }, 500);
      } else {
        setError('Incorrect PIN code');
        setShakeTrigger(true);
        triggerHaptic([60, 40, 60]);
        setTimeout(() => setShakeTrigger(false), 500);
        setPin('');
      }
    }
  }, [pin, security.isPinCreated]);

  const toggleTheme = () => {
    const currentSettings = getAppSettings();
    const nextTheme = theme === 'light' ? 'dark' : 'light';
    saveAppSettings({ ...currentSettings, theme: nextTheme });
    
    if (nextTheme === 'dark') {
      document.documentElement.classList.add('dark');
    } else {
      document.documentElement.classList.remove('dark');
    }
    setTheme(nextTheme);
    triggerHaptic(15);
  };

  const handleNextQuote = (e: React.MouseEvent) => {
    e.stopPropagation();
    triggerHaptic(10);
    setQuoteIndex(prev => (prev + 1) % SANCTUARY_QUOTES.length);
  };

  // Resolve unified premium brand wallpaper style
  const activeBgClass = theme === 'dark' 
    ? 'bg-gradient-to-tr from-[#131012] via-[#241B1E] to-[#131012]' 
    : 'bg-gradient-to-tr from-[#FAF6F0] via-[#FFF5F1] to-[#FAF2EA]';
  const circle1Class = 'bg-brand-pink/15 dark:bg-brand-pink/25 blur-[120px]';
  const circle2Class = 'bg-brand-sage/10 dark:bg-brand-sage/18 blur-[150px]';

  return (
    <div className={`min-h-screen min-h-[100dvh] w-screen ${activeBgClass} text-brand-text flex flex-col items-center justify-between relative overflow-hidden font-sans select-none px-6 py-6 transition-all duration-700`}>
      
      {/* Atmosphere Ambient floating circles */}
      <div className="absolute inset-0 z-0 pointer-events-none overflow-hidden">
        <motion.div 
          animate={{
            scale: [1, 1.15, 1],
            x: [0, 30, 0],
            y: [0, -30, 0]
          }}
          transition={{
            duration: 15,
            repeat: Infinity,
            ease: "easeInOut"
          }}
          className={`absolute top-[-20%] left-[-20%] w-[80%] h-[80%] rounded-full opacity-60 ${circle1Class}`} 
        />
        <motion.div 
          animate={{
            scale: [1, 1.2, 1],
            x: [0, -40, 0],
            y: [0, 40, 0]
          }}
          transition={{
            duration: 20,
            repeat: Infinity,
            ease: "easeInOut",
            delay: 2
          }}
          className={`absolute bottom-[-20%] right-[-10%] w-[90%] h-[90%] rounded-full opacity-50 ${circle2Class}`} 
        />
      </div>

      {/* Subtle soothing dark-mode stardust indicator */}
      {theme === 'dark' && (
        <div className="absolute inset-0 pointer-events-none overflow-hidden z-0">
          <div className="absolute top-[12%] left-[24%] w-1 h-1 bg-brand-pink rounded-full animate-ping opacity-30" style={{ animationDuration: '4s' }} />
          <div className="absolute top-[28%] right-[16%] w-1 h-1 bg-white rounded-full animate-pulse opacity-40" style={{ animationDuration: '5s' }} />
          <div className="absolute top-[65%] left-[18%] w-1 h-1 bg-white rounded-full animate-pulse opacity-50" style={{ animationDuration: '4.5s' }} />
          <div className="absolute bottom-[22%] right-[28%] w-1 h-1 bg-brand-pink rounded-full animate-ping opacity-35" style={{ animationDuration: '3s' }} />
        </div>
      )}

      {/* Top Header Panel: Controls */}
      <header className="w-full max-w-sm flex justify-between items-center z-10">
        {/* Elegant static branding badge replacing the presets switcher */}
        <div className="flex items-center gap-2 bg-white/70 dark:bg-black/15 backdrop-blur-xl px-3.5 py-1.5 rounded-full border border-brand-border/60 dark:border-white/5 shadow-sm">
          <BookOpen className="w-3.5 h-3.5 text-brand-pink" />
          <span className="text-[9px] font-bold uppercase tracking-[0.2em] text-[#3E2429] dark:text-[#EADCD1]">Dear Diary</span>
        </div>

        {/* Dynamic Theme Toggle */}
        <motion.button
          onClick={toggleTheme}
          whileHover={{ scale: 1.05 }}
          whileTap={{ scale: 0.95 }}
          className="w-9 h-9 rounded-full bg-white/70 dark:bg-black/15 border border-brand-border/60 dark:border-white/5 backdrop-blur-xl flex items-center justify-center text-brand-plum hover:text-brand-pink transition-colors shadow-sm cursor-pointer"
          title={`Switch to ${theme === 'light' ? 'Dark' : 'Light'} Mode`}
        >
          {theme === 'light' ? <Moon className="w-4 h-4" /> : <Sun className="w-4 h-4 text-amber-200" />}
        </motion.button>
      </header>

      {/* Central Viewport with Slide Transition */}
      <main className="w-full max-w-sm flex-grow flex flex-col justify-center items-center z-10 relative">
        <AnimatePresence mode="wait">
          {screenMode === 'ambient' ? (
            /* ================= AMBIENT MODE ================= */
            <motion.div
              key="ambient_mode"
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              exit={{ opacity: 0, y: -40, scale: 0.98 }}
              transition={{ duration: 0.4, ease: [0.16, 1, 0.3, 1] }}
              className="w-full flex flex-col items-center text-center justify-between h-[65vh] sm:h-[70vh] py-4"
            >
              {/* Live Elegant Clock / Calendar */}
              <div className="space-y-2 mt-4 select-none">
                <motion.h2 
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.1, duration: 0.6 }}
                  className="font-serif text-6xl sm:text-7xl font-extralight tracking-tight text-brand-plum leading-none"
                >
                  {time}
                </motion.h2>
                <motion.p 
                  initial={{ opacity: 0, y: 5 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={{ delay: 0.2, duration: 0.6 }}
                  className="text-[11px] sm:text-xs font-semibold tracking-[0.2em] text-brand-text-muted uppercase"
                >
                  {date}
                </motion.p>
              </div>

              {/* Pulsing Lock / Biometric Trigger Button */}
              <div className="flex flex-col items-center gap-4">
                {security.isBiometricsEnabled ? (
                  <motion.button
                    onClick={handleBiometricUnlock}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="flex flex-col items-center gap-2.5 group"
                  >
                    <div className="w-18 h-18 rounded-full bg-white/80 dark:bg-black/10 border border-brand-border dark:border-white/10 backdrop-blur-md flex items-center justify-center shadow-lg shadow-brand-plum/[0.04] dark:shadow-none group-hover:bg-white dark:group-hover:bg-black/20 transition-all relative">
                      <motion.div
                        animate={{ scale: [1, 1.15, 1], opacity: [0.3, 0.6, 0.3] }}
                        transition={{ duration: 2.5, repeat: Infinity, ease: "easeInOut" }}
                        className="absolute inset-0 rounded-full border-2 border-brand-pink pointer-events-none"
                      />
                      <Fingerprint className="w-8 h-8 text-brand-pink animate-pulse" />
                    </div>
                    <span className="text-[10px] font-bold tracking-[0.25em] text-brand-pink dark:text-brand-pink-dark uppercase">
                      Touch to Scan
                    </span>
                  </motion.button>
                ) : (
                  <motion.button
                    onClick={() => {
                      triggerHaptic(15);
                      setScreenMode('keypad');
                    }}
                    whileHover={{ scale: 1.05 }}
                    whileTap={{ scale: 0.95 }}
                    className="flex flex-col items-center gap-2.5 group"
                  >
                    <div className="w-16 h-16 rounded-full bg-white/80 dark:bg-black/10 border border-brand-border dark:border-white/10 backdrop-blur-md flex items-center justify-center shadow-md hover:shadow-lg hover:border-brand-pink/30 dark:hover:border-white/25 transition-all relative">
                      <motion.div
                        animate={{ scale: [1, 1.1, 1], opacity: [0.2, 0.4, 0.2] }}
                        transition={{ duration: 3, repeat: Infinity, ease: "easeInOut" }}
                        className="absolute inset-0 rounded-full border border-brand-plum/25 pointer-events-none"
                      />
                      <Lock className="w-6 h-6 text-brand-plum/85 dark:text-brand-text/80 group-hover:text-brand-pink transition-colors stroke-[1.5]" />
                    </div>
                    <span className="text-[10px] font-bold tracking-[0.2em] text-brand-text-muted uppercase opacity-90 group-hover:opacity-100 group-hover:text-brand-pink transition-colors">
                      Tap to Unlock
                    </span>
                  </motion.button>
                )}

                {security.isBiometricsEnabled && (
                  <button
                    onClick={() => {
                      triggerHaptic(12);
                      setScreenMode('keypad');
                    }}
                    className="text-[10px] font-bold text-brand-text-muted hover:text-brand-pink uppercase tracking-widest underline decoration-dotted mt-1"
                  >
                    Use PIN Code
                  </button>
                )}
              </div>

              {/* Mindfulness Sanctuary Prompt Card */}
              <motion.div
                initial={{ opacity: 0, y: 15 }}
                animate={{ opacity: 1, y: 0 }}
                transition={{ delay: 0.3 }}
                onClick={() => {
                  triggerHaptic(15);
                  setScreenMode('keypad');
                }}
                className="w-full max-w-xs bg-white dark:bg-[#1A1517]/35 border border-brand-border dark:border-white/10 p-4 rounded-2xl shadow-md shadow-[#2C1D21]/5 text-center flex flex-col gap-2 relative group overflow-hidden cursor-pointer hover:bg-brand-pink/[0.02] dark:hover:bg-[#1A1517]/45 transition-colors"
              >
                {/* Book spine aesthetic */}
                <div className="absolute left-0 top-0 bottom-0 w-1 bg-gradient-to-r from-brand-pink/15 to-transparent" />
                
                <p className="text-[9px] font-bold tracking-[0.2em] text-brand-pink dark:text-brand-pink uppercase">
                  Mindful Sanctuary
                </p>
                
                <div className="min-h-[48px] flex items-center justify-center px-2">
                  <AnimatePresence mode="wait">
                    <motion.p
                      key={quoteIndex}
                      initial={{ opacity: 0, y: 5 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -5 }}
                      transition={{ duration: 0.4 }}
                      className="font-serif-diary text-xs sm:text-[13px] text-[#4F3C42] dark:text-[#ECE6E1] italic leading-relaxed"
                    >
                      "{SANCTUARY_QUOTES[quoteIndex]}"
                    </motion.p>
                  </AnimatePresence>
                </div>
                
                <button
                  onClick={handleNextQuote}
                  className="self-center p-1 rounded-lg hover:bg-black/5 dark:hover:bg-white/10 text-brand-text-muted hover:text-brand-pink transition-all"
                  title="Cycle Inspiration"
                >
                  <Sparkles className="w-3.5 h-3.5 animate-pulse" />
                </button>
              </motion.div>
            </motion.div>
          ) : (
            /* ================= KEYPAD SECURITY MODE ================= */
            <motion.div
              key="keypad_mode"
              initial={{ opacity: 0, y: 80 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 80 }}
              transition={{ type: "spring", damping: 25, stiffness: 180 }}
              className="w-full"
            >
              <motion.div 
                animate={shakeTrigger ? { x: [-10, 10, -8, 8, -5, 5, 0] } : {}}
                transition={{ duration: 0.4 }}
                className="w-full p-4 sm:p-5 flex flex-col gap-4 relative overflow-hidden"
              >
                {/* Return to Ambient view button */}
                {security.isPinCreated && (
                  <button
                    onClick={() => {
                      triggerHaptic(10);
                      setScreenMode('ambient');
                      setPin('');
                      setError('');
                    }}
                    className="absolute top-1 left-1 p-2 rounded-full hover:bg-white/40 dark:hover:bg-black/20 text-brand-text-muted hover:text-brand-plum transition-colors"
                    title="Back to Clock"
                  >
                    <ArrowLeft className="w-4 h-4 stroke-[2.5]" />
                  </button>
                )}

                {/* Header branding */}
                <div className="text-center space-y-1 sm:space-y-1.5 flex flex-col items-center mt-2">
                  <motion.div 
                    initial={{ scale: 0.8, opacity: 0 }}
                    animate={{ scale: 1, opacity: 1 }}
                    transition={{ type: "spring", stiffness: 120, delay: 0.1 }}
                    className="w-12 h-12 sm:w-14 sm:h-14 rounded-2xl bg-white dark:bg-[#1A1517]/40 border border-brand-border dark:border-white/5 shadow-md shadow-[#2C1D21]/5 flex items-center justify-center relative group backdrop-blur-md"
                  >
                    <div className="absolute inset-0.5 rounded-[10px] border border-brand-pink/5 group-hover:border-brand-pink/15 transition-colors" />
                    <BookOpen className="w-5.5 h-5.5 sm:w-6.5 sm:h-6.5 text-brand-pink" />
                  </motion.div>
                  
                  <div className="space-y-0.5">
                    <h1 className="font-serif-diary text-xl sm:text-2xl text-[#2C1D21] dark:text-[#ECE6E1] font-bold tracking-tight">Dear Diary</h1>
                    <p className="text-[8px] sm:text-[9px] font-bold tracking-[0.25em] text-brand-pink dark:text-brand-pink-dark uppercase">Your Private Sanctuary</p>
                  </div>
                </div>

                {/* Subtext info for Setup PIN mode */}
                {!security.isPinCreated && (
                  <div className="text-center py-1 border-b border-brand-pink/10 pb-2">
                    <span className="inline-flex p-1.5 bg-brand-pink/10 text-brand-pink rounded-xl mb-1">
                      <ShieldCheck className="w-4 h-4" />
                    </span>
                    <h2 className="text-xs sm:text-sm font-bold text-[#2C1D21] dark:text-[#ECE6E1]">Setup Security PIN</h2>
                    <p className="text-[10px] sm:text-[11px] text-brand-text-muted mt-1 leading-relaxed max-w-[240px] mx-auto">
                      {isConfirming 
                        ? 'Confirm your security PIN code to lock.' 
                        : 'Choose a memorable 4-digit PIN to secure your diary.'}
                    </p>
                  </div>
                )}

                {/* Biometrics button on Keypad (Convenience fallback) */}
                {security.isPinCreated && security.isBiometricsEnabled && (
                  <motion.button
                    whileHover={{ scale: 0.99 }}
                    whileTap={{ scale: 0.97 }}
                    onClick={handleBiometricUnlock}
                    className="w-full bg-brand-pink/90 dark:bg-brand-pink text-white py-3 rounded-2xl flex items-center justify-center gap-2.5 transition-all duration-300 font-bold text-xs uppercase tracking-wider shadow-md shadow-brand-pink/15 relative overflow-hidden group cursor-pointer hover:bg-brand-pink hover:scale-[1.01]"
                  >
                    {isBiometricActive && (
                      <motion.div 
                        initial={{ scale: 0, opacity: 0.5 }}
                        animate={{ scale: 3, opacity: 0 }}
                        transition={{ duration: 1, repeat: Infinity }}
                        className="absolute w-24 h-24 bg-white/20 rounded-full"
                      />
                    )}
                    <Fingerprint className="w-4 h-4" />
                    <span>Scan Biometric Authenticator</span>
                  </motion.button>
                )}

                {security.isPinCreated && security.isBiometricsEnabled && (
                  <div className="flex items-center gap-4 py-0.5 opacity-40">
                    <div className="h-[1px] bg-brand-border flex-grow" />
                    <span className="text-[8px] text-brand-text-muted font-bold uppercase tracking-[0.2em]">or pin</span>
                    <div className="h-[1px] bg-brand-border flex-grow" />
                  </div>
                )}

                {/* PIN Indicator Dots */}
                <div className="flex flex-col items-center gap-2 py-1">
                  <div className="flex gap-3.5 py-1 justify-center min-h-[32px] items-center">
                    <AnimatePresence>
                      {Array.from({ length: 4 }).map((_, i) => {
                        const hasDigit = i < pin.length;
                        return (
                          <motion.div 
                            key={i} 
                            layout
                            className="relative flex items-center justify-center"
                          >
                            <motion.div 
                              initial={{ scale: 0.8 }}
                              animate={{ 
                                scale: hasDigit ? 1.15 : 1,
                                backgroundColor: isSuccessUnlocked 
                                  ? 'var(--brand-sage)' 
                                  : error 
                                  ? 'var(--brand-rose)' 
                                  : hasDigit 
                                  ? 'var(--brand-pink)' 
                                  : 'transparent',
                                borderColor: isSuccessUnlocked 
                                  ? 'var(--brand-sage)' 
                                  : error 
                                  ? 'var(--brand-rose)' 
                                  : hasDigit 
                                  ? 'var(--brand-pink)' 
                                  : 'var(--brand-text-muted)'
                              }}
                              transition={{ type: "spring", stiffness: 300, damping: 12 }}
                              className={`w-3 h-3 rounded-full border-2 transition-all ${
                                hasDigit 
                                  ? 'bg-brand-pink border-brand-pink shadow-md' 
                                  : 'border-brand-text-muted/30 bg-transparent'
                              }`}
                            />
                            {hasDigit && showPin && (
                              <span className="absolute text-[9px] font-black text-white leading-none">
                                {pin[i]}
                              </span>
                            )}
                          </motion.div>
                        );
                      })}
                    </AnimatePresence>
                  </div>

                  {/* Feedback Text Messaging */}
                  <div className="min-h-[16px] text-center flex flex-col items-center mt-1">
                    <AnimatePresence mode="wait">
                      {error && (
                        <motion.p 
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className="text-[11px] font-bold text-brand-rose flex items-center gap-1"
                        >
                          <AlertCircle className="w-3 h-3 flex-shrink-0" />
                          <span>{error}</span>
                        </motion.p>
                      )}
                      {successMsg && (
                        <motion.p 
                          initial={{ opacity: 0, y: -4 }}
                          animate={{ opacity: 1, y: 0 }}
                          exit={{ opacity: 0 }}
                          className="text-[11px] font-bold text-brand-sage flex items-center gap-1"
                        >
                          <Check className="w-3.5 h-3.5 text-brand-sage" />
                          <span>{successMsg}</span>
                        </motion.p>
                      )}
                    </AnimatePresence>
                  </div>
                </div>

                {/* Tactile Keypad */}
                <div className="grid grid-cols-3 gap-y-2.5 gap-x-5 mt-1 justify-items-center">
                  {['1', '2', '3', '4', '5', '6', '7', '8', '9'].map(num => (
                    <motion.button
                      key={num}
                      type="button"
                      whileTap={{ scale: 0.9 }}
                      onClick={() => handleKeyPress(num)}
                      className="w-12.5 h-12.5 sm:w-14 sm:h-14 rounded-full bg-white dark:bg-[#1A1517]/40 border border-brand-border dark:border-white/5 flex flex-col items-center justify-center hover:bg-brand-pink/5 dark:hover:bg-brand-pink/10 hover:border-brand-pink/20 hover:scale-105 transition-all shadow-sm shadow-[#2C1D21]/5 dark:shadow-none active:shadow-inner select-none cursor-pointer"
                    >
                      <span className="leading-none text-base sm:text-lg font-bold text-[#2C1D21] dark:text-[#ECE6E1] mt-0.5">{num}</span>
                      <span className="text-[7px] font-bold tracking-wider text-brand-text-muted uppercase opacity-75 mt-0.5">
                        {KEY_LETTERS[num] || ' '}
                      </span>
                    </motion.button>
                  ))}
                  
                  {/* Left Shortcut/Eye Toggle key */}
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.9 }}
                    onClick={() => {
                      if (pin.length > 0) {
                        handleClear();
                      } else {
                        triggerHaptic(10);
                        setShowPin(!showPin);
                      }
                    }}
                    className="w-12.5 h-12.5 sm:w-14 sm:h-14 rounded-full flex flex-col items-center justify-center text-brand-text-muted hover:text-brand-plum bg-white hover:bg-brand-blush-light dark:bg-transparent dark:hover:bg-black/20 border border-brand-border dark:border-white/10 shadow-sm transition-all select-none cursor-pointer"
                  >
                    {pin.length > 0 ? (
                      <span className="text-[10px] font-bold uppercase tracking-wider text-brand-pink">Clear</span>
                    ) : (
                      <>
                        {showPin ? <EyeOff className="w-4 h-4" /> : <Eye className="w-4 h-4" />}
                        <span className="text-[7px] font-bold tracking-wider uppercase text-brand-text-muted mt-1">Reveal</span>
                      </>
                    )}
                  </motion.button>

                  {/* Digit 0 */}
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.9 }}
                    onClick={() => handleKeyPress('0')}
                    className="w-12.5 h-12.5 sm:w-14 sm:h-14 rounded-full bg-white dark:bg-[#1A1517]/40 border border-brand-border dark:border-white/5 flex flex-col items-center justify-center hover:bg-brand-pink/5 dark:hover:bg-brand-pink/10 hover:border-brand-pink/20 hover:scale-105 transition-all shadow-sm shadow-[#2C1D21]/5 dark:shadow-none active:shadow-inner select-none cursor-pointer"
                  >
                    <span className="leading-none text-base sm:text-lg font-bold text-[#2C1D21] dark:text-[#ECE6E1] mt-1">0</span>
                    <span className="text-[7px] font-bold text-brand-text-muted opacity-50 mt-0.5"> </span>
                  </motion.button>

                  {/* Backspace Button */}
                  <motion.button
                    type="button"
                    whileTap={{ scale: 0.9 }}
                    onClick={handleBackspace}
                    disabled={pin.length === 0}
                    className={`w-12.5 h-12.5 sm:w-14 sm:h-14 rounded-full flex flex-col items-center justify-center text-brand-pink hover:text-brand-pink-dark bg-white hover:bg-brand-blush-light dark:bg-transparent dark:hover:bg-black/20 border border-brand-border dark:border-white/10 shadow-sm transition-all select-none cursor-pointer ${
                      pin.length === 0 ? 'opacity-30 cursor-not-allowed' : ''
                    }`}
                  >
                    <Delete className="w-4.5 h-4.5 sm:w-5 sm:h-5" />
                    <span className="text-[7px] font-bold tracking-wider uppercase text-brand-text-muted mt-1">Erase</span>
                  </motion.button>
                </div>

                {/* Confirm PIN button (only shows when creating first-time PIN) */}
                {!security.isPinCreated && (
                  <motion.button
                    whileTap={{ scale: 0.98 }}
                    onClick={() => handleSubmit()}
                    disabled={pin.length < 4}
                    className={`w-full py-3.5 rounded-2xl font-bold text-[11px] sm:text-xs uppercase tracking-widest transition-all mt-2 shadow-md cursor-pointer ${
                      pin.length >= 4 
                        ? 'bg-brand-pink text-white hover:bg-brand-pink-dark shadow-brand-pink/15' 
                        : 'bg-brand-border/60 text-brand-text-muted opacity-40 cursor-not-allowed'
                    }`}
                  >
                    {isConfirming ? 'Confirm Password PIN' : 'Advance to Next Step'}
                  </motion.button>
                )}

                {/* Forgot PIN trigger (only for login mode) */}
                {security.isPinCreated && !error && !successMsg && !isResetting && (
                  <div className="text-center pt-1 mt-2">
                    <button 
                      onClick={() => {
                        triggerHaptic(15);
                        setResetOption('choosing');
                      }}
                      className="text-[10px] sm:text-[11px] font-bold text-brand-text-muted hover:text-brand-pink underline tracking-wide cursor-pointer transition-colors"
                    >
                      Forgot security passcode PIN?
                    </button>
                  </div>
                )}

                {/* High-UX Recover PIN Full-Card Overlay Modal */}
                <AnimatePresence>
                  {resetOption && (
                    <motion.div
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      exit={{ opacity: 0 }}
                      className="absolute inset-0 z-40 bg-brand-bg/95 dark:bg-brand-bg/95 backdrop-blur-md p-6 flex flex-col justify-center items-center text-center gap-4"
                    >
                      <motion.div
                        initial={{ scale: 0.85, opacity: 0 }}
                        animate={{ scale: 1, opacity: 1 }}
                        exit={{ scale: 0.85, opacity: 0 }}
                        transition={{ type: "spring", damping: 20 }}
                        className="flex flex-col items-center gap-3.5"
                      >
                        <div className="w-12 h-12 rounded-full bg-brand-pink/10 flex items-center justify-center text-brand-pink">
                          <ShieldCheck className="w-6 h-6 stroke-[2]" />
                        </div>
                        <h3 className="font-serif-diary text-lg font-bold text-brand-plum">Reset Passcode PIN</h3>
                        <p className="text-[11px] leading-relaxed text-brand-text-muted max-w-[220px]">
                          Please select an option below to regain access to your private sanctuary.
                        </p>
                        
                        <div className="flex flex-col gap-2 w-full min-w-[200px] mt-2">
                          <button
                            onClick={() => handleForgotPassword('google')}
                            className="w-full bg-brand-pink text-white py-2.5 rounded-xl text-[10px] font-extrabold uppercase tracking-widest hover:bg-brand-pink-dark transition-colors shadow-md shadow-brand-pink/10"
                          >
                            Verify via Google Account
                          </button>
                          <button
                            onClick={() => handleForgotPassword('local')}
                            className="w-full bg-brand-blush-dark dark:bg-[#2D2529] text-brand-plum py-2.5 rounded-xl text-[10px] font-extrabold uppercase tracking-widest hover:bg-brand-border/40 transition-colors border border-brand-border"
                          >
                            Reset Locally (Wipe PIN)
                          </button>
                          <button
                            onClick={() => {
                              triggerHaptic(10);
                              setResetOption(null);
                            }}
                            className="w-full py-2 text-[10px] font-black uppercase tracking-wider text-brand-text-muted hover:text-brand-plum mt-1"
                          >
                            Cancel
                          </button>
                        </div>
                      </motion.div>
                    </motion.div>
                  )}
                </AnimatePresence>
              </motion.div>
            </motion.div>
          )}
        </AnimatePresence>
      </main>

      {/* Footer Info Badge */}
      <footer className="w-full max-w-sm text-center flex flex-col items-center gap-1 z-10 py-1 opacity-70">
        <div className="flex items-center gap-1 bg-brand-rose-light/50 dark:bg-black/10 px-2.5 py-0.5 rounded-full border border-brand-border/80 dark:border-white/5 text-[8px] sm:text-[9px] font-bold text-brand-plum dark:text-brand-text-muted uppercase tracking-widest">
          <Lock className="w-2.5 h-2.5 sm:w-3 sm:h-3" />
          <span>Device Secured Sanctuary</span>
        </div>
        <p className="text-[8px] sm:text-[9px] text-brand-text-muted max-w-[240px] leading-normal font-medium">
          Locked entries are protected by military-grade client-side on-device protection. Your secrets remain entirely yours.
        </p>
      </footer>
    </div>
  );
}
