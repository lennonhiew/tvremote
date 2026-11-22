// Public settings. The anon key is meant to be public: every tv_ table is closed to it, and the
// only things it can call are the tv_ functions, which check a signed-in session (or the TV's own token).
export const CONFIG = {
  supabaseUrl: "https://tmhzfcphtbbaiuxsfzzo.supabase.co",
  anonKey: "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InRtaHpmY3BodGJiYWl1eHNmenpvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTI3ODA2MzcsImV4cCI6MjEwODM1NjYzN30.TXumOLQvm8vDx2YseUYC98WrnnbywjAvnKShnpu75wU",
};

// Ready-made shows for Abbie's time (official Les' Copaque playlists on YouTube).
export const SHOWS = [
  { id: "PLdm4JCUOHx8701zpqOlb016MkKs7Gg-2d", title: "Upin & Ipin · Full episodes" },
  { id: "PLdm4JCUOHx85MZHj2maGiAbZ8gUxAfji4", title: "Upin & Ipin · Musim 20" },
  { id: "PLdm4JCUOHx86V2kNcKdk4G8XeV_ulDIvq", title: "Upin & Ipin · Musim 19" },
  { id: "PLdm4JCUOHx874J0uQtVlAxnfEH4MMF7sz", title: "Upin & Ipin · Musim 18" },
  { id: "PLdm4JCUOHx86Wl3Zjc1baM2WJhm-enbYY", title: "Upin & Ipin · Musim 17" },
  { id: "PLdm4JCUOHx84oMFz08q96LREDvRu9pPHG", title: "Upin & Ipin · Ramadan Raya" },
  { id: "PLdm4JCUOHx84-LKfKBq3NTHUzQI9ySkei", title: "Upin & Ipin · The Helping Heroes S2" },
];
