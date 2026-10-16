Pod::Spec.new do |s|
  s.name           = 'MicPcm'
  s.version        = '0.1.0'
  s.summary        = 'Microphone PCM capture (levels only, never written anywhere) for sound-meter and tuner-metronome'
  s.description    = 'AVAudioEngine input tap in measurement mode, ring buffer with frame positions and monotonic capture times'
  s.author         = ''
  s.homepage       = 'https://docs.expo.dev/modules/'
  s.platforms      = { :ios => '16.4' }
  s.source         = { git: '' }
  s.static_framework = true
  s.dependency 'ExpoModulesCore'
  s.pod_target_xcconfig = { 'DEFINES_MODULE' => 'YES' }
  s.source_files = "**/*.{h,m,mm,swift,hpp,cpp}"
end
