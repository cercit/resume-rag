(function (global) {
  "use strict";

  // This fixed sample is fictional. It is never presented as a rewrite of a visitor's resume.
  const sourceResume = `Aarav Sharma
Product Analyst
Bengaluru, India | aarav@example.com | Portfolio: example.com/aarav

SUMMARY
Product Analyst working on product analytics, experimentation, and customer research.
I use SQL, Python, Excel, and Tableau to help product teams understand customer behaviour and make decisions.
I work with product managers, designers, and engineers on onboarding and retention.

SKILLS
Product analytics: Funnel analysis, cohort analysis, retention analysis, A/B testing, metric definitions
Data: SQL, Python, Excel, Tableau, data validation, dashboard reporting
Collaboration: Customer interviews, stakeholder communication, experiment planning, product requirements

EXPERIENCE
Northstar Labs
Product Analyst | Jul 2023 - Present
Product analytics for a subscription learning app.
- Analysed onboarding funnels with SQL and identified a drop-off at the first lesson.
- Worked with design and engineering on a simpler onboarding flow. Activation increased by 18% in the follow-up A/B test.
- Built 12 Tableau dashboards for 4 product squads, covering activation, retention, and subscription conversion.
- Automated weekly reporting with Python and SQL, saving 6 hours of manual work each week.
- Defined experiment success metrics with product managers and checked data quality before test launches.
- Reviewed retention cohorts and shared findings in weekly product reviews.
- Joined 8 customer interviews to understand why new learners stopped using the app.
- Documented event definitions so analysts and engineers used the same product metrics.

Orbit Commerce
Associate Analyst | Jun 2021 - Jun 2023
Reporting and analysis for an online retail product.
- Created Excel reports for weekly product and operations reviews.
- Used SQL to compare checkout conversion across 5 markets and identify where customers left the flow.
- Checked order data against source records and corrected reporting inconsistencies with the engineering team.
- Built a Tableau dashboard for repeat purchase and customer cohorts.
- Wrote short findings and recommendations for product managers after each analysis.
- Documented recurring reporting requests and metric definitions for the analytics team.

PROJECTS
Customer retention study | Feb 2023
- Analysed a public retail dataset of 120,000 events with Python and SQL.
- Compared retention across customer cohorts and presented the findings in Tableau.
- Documented data cleaning decisions and the limits of the analysis.

Onboarding experiment review | Nov 2024
- Reviewed the onboarding A/B test at Northstar Labs and documented its 18% activation increase.
- Wrote a short project note describing the hypothesis, success metric, and next questions.

EDUCATION
B.Tech in Computer Science | 2017 - 2021
Westbridge Institute of Technology, Bengaluru

LANGUAGES
English, Hindi, Kannada

This is a fictional sample profile. All people, employers, and educational institutions in this sample are fictional.`;

  const jobDescription = `Product Analyst
Harbour / Bengaluru

Help our product teams understand how customers use our subscription platform.

Responsibilities
- Analyse onboarding funnels, activation, and retention with SQL.
- Build Tableau dashboards and define product metrics.
- Plan A/B tests with product managers, designers, and engineers.
- Use Python to investigate product data and automate reporting.
- Combine quantitative analysis with customer interviews.
- Communicate findings clearly and recommend the next experiment.

Requirements
- Experience with SQL, Python, Tableau, funnel analysis, cohort analysis, and A/B testing.
- Clear stakeholder communication and attention to data quality.
- Experience with Amplitude and dbt is preferred.

This is a fictional job description for the interactive sample.`;

  const resume = {
    contact: {
      name: "Aarav Sharma",
      location: "Bengaluru, India",
      email: "aarav@example.com",
      phone: "",
      links: [{ label: "Portfolio", url: "example.com/aarav" }]
    },
    role_line: "Product Analyst",
    file_name: "Aarav_Sharma_Product_Analyst_SAMPLE",
    summary: [
      "Product Analyst working on product analytics, experimentation, and customer research. Uses SQL, Python, Excel, and Tableau to help product teams understand customer behaviour and make decisions.",
      "Works with product managers, designers, and engineers on onboarding and retention."
    ],
    skills: [
      ["Product analytics", "Funnel analysis, cohort analysis, retention analysis, A/B testing, metric definitions"],
      ["Data", "SQL, Python, Tableau, Excel, data validation, dashboard reporting"],
      ["Collaboration", "Customer interviews, stakeholder communication, experiment planning, product requirements"]
    ],
    tools: "",
    experience: [
      {
        company: "Northstar Labs",
        title: "Product Analyst",
        dates: "Jul 2023 - Present",
        intro: "Product analytics for a subscription learning app.",
        bullets: [
          "Analysed onboarding funnels with SQL and identified a drop-off at the first lesson.",
          "Worked with design and engineering on a simpler onboarding flow. Activation increased by 18% in the follow-up A/B test.",
          "Built 12 Tableau dashboards for 4 product squads, covering activation, retention, and subscription conversion.",
          "Automated weekly reporting with Python and SQL, saving 6 hours of manual work each week.",
          "Defined experiment success metrics with product managers and checked data quality before test launches.",
          "Reviewed retention cohorts and shared findings in weekly product reviews.",
          "Joined 8 customer interviews to understand why new learners stopped using the app.",
          "Documented event definitions so analysts and engineers used the same product metrics."
        ]
      },
      {
        company: "Orbit Commerce",
        title: "Associate Analyst",
        dates: "Jun 2021 - Jun 2023",
        intro: "Reporting and analysis for an online retail product.",
        bullets: [
          "Used SQL to compare checkout conversion across 5 markets and identify where customers left the flow.",
          "Built a Tableau dashboard for repeat purchase and customer cohorts.",
          "Checked order data against source records and corrected reporting inconsistencies with the engineering team.",
          "Created Excel reports for weekly product and operations reviews.",
          "Wrote short findings and recommendations for product managers after each analysis.",
          "Documented recurring reporting requests and metric definitions for the analytics team."
        ]
      }
    ],
    portfolio: [
      {
        name: "Onboarding experiment review",
        date: "Nov 2024",
        bullets: [
          "Reviewed the onboarding A/B test at Northstar Labs and documented its 18% activation increase.",
          "Wrote a short project note describing the hypothesis, success metric, and next questions."
        ]
      },
      {
        name: "Customer retention study",
        date: "Feb 2023",
        bullets: [
          "Analysed a public retail dataset of 120,000 events with Python and SQL.",
          "Compared retention across customer cohorts and presented the findings in Tableau.",
          "Documented data cleaning decisions and the limits of the analysis."
        ]
      }
    ],
    order: ["experience", "portfolio"],
    education: [{ title: "B.Tech in Computer Science", dates: "2017 - 2021", place: "Westbridge Institute of Technology, Bengaluru" }],
    certifications: "",
    languages: "English, Hindi, Kannada",
    hobbies: ""
  };

  const notes = {
    keywords_found: ["SQL", "Python", "Tableau", "Funnel analysis", "Cohort analysis", "A/B testing", "Customer interviews", "Stakeholder communication"],
    keywords_missing: ["Amplitude", "dbt"],
    gaps: [
      "The job prefers Amplitude and dbt. The sample resume does not show either tool, so they have not been added.",
      "Review every line before sending a resume. This example uses a fixed fictional profile."
    ]
  };

  const tips = [
    { title: "One role. One tailored resume.", body: "Every job has different priorities. Give each application its own version, with your most relevant experience up front." },
    { title: "Lead with relevance.", body: "Put the experience that best fits this role near the top." },
    { title: "Keep the evidence.", body: "Use numbers already in your resume. Never add a number just to sound impressive." },
    { title: "You've already done the work.", body: "The projects, the problems solved, the things you learned. This minute helps someone see how that experience fits their team." },
    { title: "Name the work.", body: "Built a reporting dashboard tells a reader more than responsible for reporting." },
    { title: "Make it easy to scan.", body: "Keep each bullet focused on one contribution." },
    { title: "Use familiar wording.", body: "Match the job's terminology when it accurately describes your experience." },
    { title: "A fresh opportunity. A fresh version.", body: "Keep a base resume, then tailor a copy for each role. Save it with the company and role in the filename so it's easy to find." },
    { title: "Keep your titles true.", body: "Explain relevant responsibilities without upgrading your job title." },
    { title: "Mind the gaps.", body: "Review a missing skill. Add it only if you have the experience to support it." },
    { title: "One thoughtful application at a time.", body: "Job hunting can ask a lot of you. Take this one step at your own pace. A clear, honest story is a good place to start." },
    { title: "Read it out loud.", body: "If a sentence does not sound like you, ask for a simpler version." }
  ];

  const quizzes = [
    {
      question: "Which bullet says more?",
      options: ["Responsible for customer reports.", "Built weekly customer reports in Excel."],
      answer: 1,
      explanation: "The second bullet names the task, frequency, and tool. Use those details only when they are true."
    },
    {
      question: "A job asks for Docker. Your resume does not mention it. What should happen?",
      options: ["Add Docker to improve the match.", "Show it as a gap to review."],
      answer: 1,
      explanation: "Show it as a gap. Your resume should only claim skills supported by your experience."
    },
    {
      question: "Your resume has no sales figures. Should a rewrite add an estimated increase?",
      options: ["Yes, an estimate sounds stronger.", "No, keep the claim supported."],
      answer: 1,
      explanation: "Keep the claim supported. A specific number belongs in your resume only when you can back it up."
    }
  ];

  global.TailorDemo = {
    sampleOnly: true,
    label: "Fictional sample",
    role: "Product Analyst",
    company: "Harbour",
    sourceResume: sourceResume,
    jobDescription: jobDescription,
    resume: resume,
    notes: notes,
    tips: tips,
    quizzes: quizzes
  };
})(window);
