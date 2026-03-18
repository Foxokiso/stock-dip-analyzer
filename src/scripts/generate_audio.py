import wave
import struct
import math
import os

# Generate an ominous, alien-like drone sound
filename = "c:/Users/Frunk/experim,ents/stock-dip-analyzer/src/assets/alien_ominous.wav"
os.makedirs(os.path.dirname(filename), exist_ok=True)

sample_rate = 44100
duration = 4.0  # seconds

# Create audio file
obj = wave.open(filename, 'w')
obj.setnchannels(1) # mono
obj.setsampwidth(2) # 2 bytes = 16 bit
obj.setframerate(sample_rate)

# We want an ominous low-frequency drone with some alien oscillation
for i in range(int(sample_rate * duration)):
    t = float(i) / float(sample_rate)
    
    # Base low drone (around 60Hz - 80Hz)
    base_freq = 65.0 + math.sin(t * 0.5) * 15.0
    
    # Alien oscillating LFO (low frequency oscillator) sweeping the amplitude
    lfo = math.sin(t * 3.0) * 0.5 + 0.5
    
    # High frequency alien "chatter" or ringing
    chatter_freq = 800.0 + math.sin(t * 12.0) * 200.0
    
    # Combine signals
    val_base = math.sin(t * base_freq * math.pi * 2.0) * 16000.0 * lfo
    val_chatter = math.sin(t * chatter_freq * math.pi * 2.0) * 4000.0 * (1.0 - lfo)
    
    value = int(val_base + val_chatter)
    
    # Envelope to avoid click at start/end
    if t < 0.5:
        value = int(value * (t / 0.5))
    elif t > (duration - 0.5):
        value = int(value * ((duration - t) / 0.5))
        
    data = struct.pack('<h', value)
    obj.writeframesraw(data)

obj.close()
print(f"Generated alien audio: {filename}")
