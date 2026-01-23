/**
 * Database Seed
 *
 * Populates initial data for spaces and exercises
 */

import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();

async function main() {
  console.log('🌱 Seeding database...');

  // Create confidentiality agreement
  console.log('Creating confidentiality agreement...');
  await prisma.confidentialityAgreement.upsert({
    where: { version: 'V1_0' },
    update: {},
    create: {
      version: 'V1_0',
      summary: 'Chambers Platform Confidentiality Agreement',
      content: `CHAMBERS PLATFORM CONFIDENTIALITY AGREEMENT

Last Updated: January 2026

BY USING THE CHAMBERS PLATFORM, YOU AGREE TO THE FOLLOWING CONFIDENTIALITY TERMS:

1. CONFIDENTIALITY OF DISCUSSIONS
All discussions, posts, comments, and messages shared on Chambers are strictly confidential. Members agree to:
- Keep all content shared on the platform private
- Not screenshot, copy, or share discussions outside the platform
- Not attempt to identify other members
- Respect the anonymity of all participants

2. NO CASE-SPECIFIC DETAILS
Members must NOT share:
- Case numbers, parties' names, or identifying case details
- Information that could identify specific cases, litigants, or attorneys
- Details that could compromise judicial independence or ethics
- Confidential court proceedings or sealed information

3. ANONYMITY AND PRIVACY
- The platform operates on pseudonymous identities
- Members are responsible for maintaining their own anonymity
- Do not reveal personal identifying information about yourself or others
- The platform cannot guarantee absolute anonymity

4. REPORTING OBLIGATIONS
Members agree to:
- Report concerning content that violates these terms
- Report any content suggesting harm to self or others
- Report ethical violations or misconduct

5. PLATFORM LIMITATIONS
- Chambers is a peer support platform, not professional mental health care
- The platform cannot guarantee complete privacy or security
- Electronic communications always carry some security risk
- Chambers is not a substitute for professional counseling

6. BREACH OF CONFIDENTIALITY
Violation of these confidentiality terms may result in:
- Immediate removal from the platform
- Reporting to appropriate authorities if required by law
- Other consequences as determined by platform administrators

7. DISCLAIMER
While we strive to maintain confidentiality:
- The platform cannot control how members use information
- Technical breaches, though unlikely, are possible
- Legal obligations may require disclosure in rare circumstances

BY ACCEPTING THIS AGREEMENT, YOU ACKNOWLEDGE:
- You have read and understood these terms
- You agree to maintain confidentiality
- You understand the risks and limitations
- You will use the platform responsibly and ethically

This agreement may be updated periodically. Continued use constitutes acceptance of updates.`,
      isActive: true,
    },
  });

  console.log('✅ Created confidentiality agreement');

  // Create discussion spaces (GENERAL spaces accessible to all)
  const generalSpaces = [
    {
      name: 'The Weight Room',
      description: 'Processing heavy cases and decisions',
      color: '#1E3A5F',
      icon: 'weight',
      spaceType: 'GENERAL',
    },
    {
      name: 'Overwhelm & Workload',
      description: 'Caseload, time pressure, administrative burden',
      color: '#D4A574',
      icon: 'clock',
      spaceType: 'GENERAL',
    },
    {
      name: 'Ethical Crossroads',
      description: 'Navigating gray areas and conscience',
      color: '#4A6741',
      icon: 'scale',
      spaceType: 'GENERAL',
    },
    {
      name: 'Life Beyond the Bench',
      description: 'Family, identity, retirement transitions',
      color: '#7BA3A8',
      icon: 'home',
      spaceType: 'GENERAL',
    },
    {
      name: 'New to the Robe',
      description: 'First 5 years on the bench',
      color: '#E8A87C',
      icon: 'star',
      spaceType: 'GENERAL',
    },
    {
      name: 'Federal Perspectives',
      description: 'Federal judiciary-specific discussions',
      color: '#2A4A73',
      icon: 'building',
      spaceType: 'GENERAL',
    },
    {
      name: 'State & Local Realities',
      description: 'State, county, and municipal court issues',
      color: '#5C7D52',
      icon: 'map',
      spaceType: 'GENERAL',
    },
    {
      name: 'Mentorship Circle',
      description: 'Guidance from senior and retired judges',
      color: '#8B7E74',
      icon: 'users',
      spaceType: 'GENERAL',
    },
  ];

  // Create specialized spaces (filtered by judge characteristics)
  const specializedSpaces = [
    // Federal Circuit Spaces
    {
      name: '1st Circuit Judges',
      description: 'Federal judges in the First Circuit',
      color: '#2A4A73',
      icon: 'building',
      spaceType: 'SPECIALIZED',
      requireCourtType: 'FEDERAL',
      requireFederalCircuit: 'FIRST',
    },
    {
      name: '9th Circuit Judges',
      description: 'Federal judges in the Ninth Circuit',
      color: '#2A4A73',
      icon: 'building',
      spaceType: 'SPECIALIZED',
      requireCourtType: 'FEDERAL',
      requireFederalCircuit: 'NINTH',
    },
    {
      name: 'DC Circuit Judges',
      description: 'Federal judges in the DC Circuit',
      color: '#2A4A73',
      icon: 'building',
      spaceType: 'SPECIALIZED',
      requireCourtType: 'FEDERAL',
      requireFederalCircuit: 'DC',
    },

    // State-specific spaces (examples)
    {
      name: 'California Judges',
      description: 'Judges serving in California courts',
      color: '#5C7D52',
      icon: 'map',
      spaceType: 'SPECIALIZED',
      requireCourtType: 'STATE',
      requireStateJurisdiction: 'CA',
    },
    {
      name: 'New York Judges',
      description: 'Judges serving in New York courts',
      color: '#5C7D52',
      icon: 'map',
      spaceType: 'SPECIALIZED',
      requireCourtType: 'STATE',
      requireStateJurisdiction: 'NY',
    },
    {
      name: 'Texas Judges',
      description: 'Judges serving in Texas courts',
      color: '#5C7D52',
      icon: 'map',
      spaceType: 'SPECIALIZED',
      requireCourtType: 'STATE',
      requireStateJurisdiction: 'TX',
    },
    {
      name: 'Florida Judges',
      description: 'Judges serving in Florida courts',
      color: '#5C7D52',
      icon: 'map',
      spaceType: 'SPECIALIZED',
      requireCourtType: 'STATE',
      requireStateJurisdiction: 'FL',
    },

    // Court level spaces
    {
      name: 'Appellate Judges',
      description: 'Appeals court judges across all jurisdictions',
      color: '#7BA3A8',
      icon: 'scale',
      spaceType: 'SPECIALIZED',
      requireCourtLevel: 'APPELLATE',
    },
    {
      name: 'Trial Court Judges',
      description: 'Trial court judges across all jurisdictions',
      color: '#7BA3A8',
      icon: 'gavel',
      spaceType: 'SPECIALIZED',
      requireCourtLevel: 'TRIAL',
    },

    // Judge type spaces
    {
      name: 'Elected Judges',
      description: 'Judges who are elected to their positions',
      color: '#8B7E74',
      icon: 'users',
      spaceType: 'SPECIALIZED',
      requireJudgeType: 'ELECTED',
    },
    {
      name: 'Appointed Judges',
      description: 'Judges who are appointed to their positions',
      color: '#8B7E74',
      icon: 'users',
      spaceType: 'SPECIALIZED',
      requireJudgeType: 'APPOINTED',
    },
  ];

  // Combine all spaces
  const allSpaces = [...generalSpaces, ...specializedSpaces];

  for (const space of allSpaces) {
    await prisma.space.upsert({
      where: { name: space.name },
      update: space,
      create: space,
    });
  }

  console.log(`✅ Created ${allSpaces.length} discussion spaces (${generalSpaces.length} general, ${specializedSpaces.length} specialized)`);

  // Create exercises (content is JSON stringified for SQLite)
  const exercises = [
    // Quick Tools
    {
      slug: 'breathing-reset',
      title: 'Breathing Reset',
      description: '4-7-8 breathing technique for immediate calm',
      category: 'QUICK_TOOL' as const,
      duration: 2,
      content: {
        type: 'breathing',
        steps: [
          { instruction: 'Find a comfortable position', duration: 5 },
          { instruction: 'Breathe in through your nose', duration: 4, action: 'inhale' },
          { instruction: 'Hold your breath', duration: 7, action: 'hold' },
          { instruction: 'Exhale slowly through your mouth', duration: 8, action: 'exhale' },
        ],
        cycles: 4,
      },
      sortOrder: 1,
    },
    {
      slug: 'grounding-exercise',
      title: 'Grounding Exercise',
      description: '5-4-3-2-1 sensory awareness technique',
      category: 'GROUNDING' as const,
      duration: 3,
      content: {
        type: 'grounding',
        steps: [
          { instruction: 'Name 5 things you can see', count: 5, sense: 'sight' },
          { instruction: 'Name 4 things you can touch', count: 4, sense: 'touch' },
          { instruction: 'Name 3 things you can hear', count: 3, sense: 'sound' },
          { instruction: 'Name 2 things you can smell', count: 2, sense: 'smell' },
          { instruction: 'Name 1 thing you can taste', count: 1, sense: 'taste' },
        ],
      },
      sortOrder: 2,
    },
    {
      slug: 'perspective-shift',
      title: 'Perspective Shift',
      description: '"In 5 years, how will this matter?" reflection',
      category: 'QUICK_TOOL' as const,
      duration: 5,
      content: {
        type: 'reflection',
        prompts: [
          'What situation is weighing on you right now?',
          'In 5 years, how significant will this feel?',
          'What would you tell a colleague facing this?',
          'What is one thing you can control about this?',
        ],
      },
      sortOrder: 3,
    },

    // Reframing Exercises
    {
      slug: 'weight-of-decision',
      title: 'The Weight of Decision',
      description: 'Reframe thoughts about difficult rulings',
      category: 'REFRAMING' as const,
      duration: 10,
      content: {
        type: 'cbt_reframe',
        introduction: 'Judges carry the weight of decisions that affect lives. This exercise helps you process that weight.',
        steps: [
          {
            title: 'Identify the Thought',
            prompt: 'What automatic thought keeps returning about a recent decision?',
            example: '"I made the wrong call" or "I could have done more"',
          },
          {
            title: 'Examine the Evidence',
            prompt: 'What evidence supports this thought? What evidence contradicts it?',
            subPrompts: ['Evidence for:', 'Evidence against:'],
          },
          {
            title: 'Alternative Perspective',
            prompt: 'If a respected colleague made the same decision, what would you think of them?',
          },
          {
            title: 'Balanced Response',
            prompt: 'Write a more balanced thought that acknowledges both the difficulty and your competence.',
          },
          {
            title: 'Acceptance Statement',
            prompt: 'Complete this: "Given the information I had and the law as it stands, I..."',
          },
        ],
      },
      sortOrder: 1,
    },
    {
      slug: 'professional-isolation',
      title: 'Professional Isolation',
      description: 'Process feelings of loneliness in judicial leadership',
      category: 'REFRAMING' as const,
      duration: 12,
      content: {
        type: 'cbt_reframe',
        introduction: 'The bench can be a lonely place. This exercise helps you reframe isolation.',
        steps: [
          {
            title: 'Name the Feeling',
            prompt: 'Describe the isolation you feel. When is it strongest?',
          },
          {
            title: 'Identify the Belief',
            prompt: 'What belief underlies this feeling?',
            examples: ['"No one understands"', '"I can\'t talk to anyone"', '"I must handle this alone"'],
          },
          {
            title: 'Challenge the Belief',
            prompt: 'Is this belief entirely true? Are there exceptions?',
          },
          {
            title: 'Recognize Connection',
            prompt: 'Who in your life does understand aspects of your experience?',
          },
          {
            title: 'Reframe',
            prompt: 'Rewrite your original belief in a more nuanced, accurate way.',
          },
        ],
      },
      sortOrder: 2,
    },
    {
      slug: 'burnout-check',
      title: 'Burnout Check-In',
      description: 'Assess and address signs of judicial exhaustion',
      category: 'REFLECTION' as const,
      duration: 15,
      content: {
        type: 'assessment',
        introduction: 'Burnout in the judiciary often goes unrecognized. This check-in helps you honestly assess your state.',
        sections: [
          {
            title: 'Physical Signs',
            questions: [
              'How is your sleep quality?',
              'Are you experiencing unexplained fatigue?',
              'Have your eating habits changed?',
            ],
          },
          {
            title: 'Emotional Signs',
            questions: [
              'Do you feel increasingly cynical about the system?',
              'Is it harder to feel empathy in the courtroom?',
              'Do you dread going to work?',
            ],
          },
          {
            title: 'Behavioral Signs',
            questions: [
              'Are you withdrawing from colleagues or family?',
              'Have you stopped activities you used to enjoy?',
              'Are you making more errors than usual?',
            ],
          },
          {
            title: 'Recovery Actions',
            prompt: 'Based on your answers, what is one small thing you could do this week for yourself?',
          },
        ],
      },
      sortOrder: 3,
    },
    {
      slug: 'compassion-pause',
      title: 'Self-Compassion Pause',
      description: 'A brief practice in self-kindness',
      category: 'QUICK_TOOL' as const,
      duration: 3,
      content: {
        type: 'guided',
        steps: [
          {
            instruction: 'Place your hand on your heart',
            duration: 5,
          },
          {
            instruction: 'Acknowledge: "This is a moment of difficulty"',
            duration: 10,
          },
          {
            instruction: 'Remind yourself: "Difficulty is part of being human"',
            duration: 10,
          },
          {
            instruction: 'Offer yourself kindness: "May I be patient with myself"',
            duration: 10,
          },
          {
            instruction: 'Take three deep breaths',
            duration: 15,
          },
        ],
      },
      sortOrder: 4,
    },
    {
      slug: 'boundary-check',
      title: 'Boundary Check',
      description: '"Is this mine to carry?" reflection',
      category: 'REFLECTION' as const,
      duration: 8,
      content: {
        type: 'reflection',
        introduction: 'Judges often absorb burdens that aren\'t theirs to carry. This helps clarify boundaries.',
        prompts: [
          {
            question: 'What weight are you carrying from a recent case or interaction?',
            followUp: 'Describe it without judgment.',
          },
          {
            question: 'Is this weight yours to carry?',
            options: ['Yes, it\'s my responsibility', 'Partially', 'No, but I\'ve taken it on'],
          },
          {
            question: 'If a colleague were carrying this, what would you tell them?',
          },
          {
            question: 'What would it look like to set this down?',
          },
          {
            question: 'Complete: "I release what is not mine to carry, specifically..."',
          },
        ],
      },
      sortOrder: 5,
    },
  ];

  for (const exercise of exercises) {
    const data = {
      ...exercise,
      content: JSON.stringify(exercise.content),
    };
    await prisma.exercise.upsert({
      where: { slug: exercise.slug },
      update: data,
      create: data,
    });
  }

  console.log(`✅ Created ${exercises.length} exercises`);

  console.log('🌱 Seeding complete!');
}

main()
  .catch((e) => {
    console.error('Error seeding database:', e);
    process.exit(1);
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
