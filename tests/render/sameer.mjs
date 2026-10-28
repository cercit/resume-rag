// base/resume.example.json (fictional person) with the constants from build_resume.py turned into data,
// the shape web/render.js reads. Keep these values in step with build_resume.py.
import { readFileSync } from "node:fs";
const ex = JSON.parse(readFileSync(new URL("../../base/resume.example.json", import.meta.url), "utf8"));
export const sameer = {
  ...ex,
  contact: {
    name: "Asha Verma", location: "Bengaluru", phone: "+91 90000 00000", email: "asha.verma@example.com",
    links: [{ label: "linkedin.com/in/asha-verma-example", url: "https://linkedin.com/in/asha-verma-example" },
            { label: "asha-verma.example.com", url: "https://asha-verma.example.com" }],
  },
  experience: ex.experience.map((j) => ({ company: "Northwind Finance Ltd · 8 years", ...j })),
  education: [
    { title: "Certificate, Business Analytics", dates: "Jan 2026 – Jun 2026", place: "Example Institute of Management, Bengaluru" },
    { title: "Bachelor of Commerce (B.Com)", dates: "2014 – 2017, First Class", place: "Example College of Commerce, Mysuru" },
  ],
  certifications: "SQL Basics (Example Academy, 2025) · Power BI Data Analyst (Example Academy, 2024) · Python for Data Analysis (Example Academy, 2024)",
  languages: "Kannada (native), English (professional working), Hindi (professional working)",
  hobbies: "Running, chess",
};
