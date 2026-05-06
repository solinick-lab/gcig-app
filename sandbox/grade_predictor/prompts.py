"""Prompt templates for the grade predictor.

Two prompts:

  build_predict_prompt       given a new essay + retrieved prior
                             examples from the same teacher (+
                             optional rubric), produce a structured
                             grade + line-by-line comments

  build_initial_predict_prompt   used for a teacher with zero training
                                 examples — a "cold start" prediction
                                 that relies on the rubric + general
                                 grading principles only

Both end with an explicit "respond as JSON" instruction. The shape
the LLM is asked to return:

    {
      "line_by_line": [{"quote": "...", "comment": "..."}, ...],
      "overall_feedback": "...",
      "grade": "...",
      "rubric_breakdown": {"<criterion>": "<score + reasoning>"} | null
    }
"""

from __future__ import annotations

from typing import Iterable


def _truncate(text: str, max_chars: int) -> str:
    if len(text) <= max_chars:
        return text
    return text[: max_chars - 50] + " […truncated…]"


def build_predict_prompt(
    *,
    essay: str,
    teacher: str,
    rubric: str | None,
    examples: Iterable,
) -> str:
    """examples is an iterable of TrainingExample with .essay,
    .feedback, .grade attributes (as defined in db.py)."""
    parts: list[str] = []

    parts.append(
        f"You are predicting how the teacher named {teacher} would grade a "
        f"student essay. You have {len(list(examples))} prior examples of "
        f"how this teacher grades. Match their style, comment density, "
        f"vocabulary, and grade distribution — your job is to mimic this "
        f"specific teacher, not to give your own opinion."
    )

    examples_list = list(examples)
    if examples_list:
        parts.append(
            "\n--- PRIOR EXAMPLES OF " + teacher.upper() + "'S GRADING ---\n"
        )
        for i, ex in enumerate(examples_list, 1):
            parts.append(
                f"\n=== EXAMPLE {i} ===\n"
                f"STUDENT ESSAY:\n{_truncate(ex.essay, 2500)}\n\n"
                f"TEACHER'S COMMENTS / FEEDBACK:\n{_truncate(ex.feedback, 2000)}\n\n"
                f"GRADE GIVEN: {ex.grade}\n"
            )

    if rubric:
        parts.append(
            "\n--- RUBRIC FOR THE NEW ESSAY ---\n"
            f"{_truncate(rubric, 3000)}\n"
        )

    parts.append(
        "\n--- NEW ESSAY TO GRADE ---\n"
        f"{_truncate(essay, 8000)}\n"
    )

    parts.append(
        "\n--- TASK ---\n"
        "Produce a grade prediction for the new essay in this teacher's style. "
        "Output ONLY a JSON object with these keys (no prose before or after):\n"
        '  "line_by_line": array of {"quote": "<short verbatim phrase from the essay>", "comment": "<the teacher\'s margin note>"}\n'
        '  "overall_feedback": string — 2-4 sentences in the teacher\'s voice\n'
        '  "grade": string — match the format the teacher used in the examples (letter grade, percent, X/Y, etc.)\n'
        '  "rubric_breakdown": object mapping rubric criterion → score + one-sentence reason, or null if no rubric was given\n'
        "Aim for 6-15 line_by_line entries depending on essay length. "
        "Quote phrases that actually appear in the essay verbatim. "
        "Do not invent passages."
    )
    return "\n".join(parts)


def build_initial_predict_prompt(
    *,
    essay: str,
    teacher: str,
    rubric: str | None,
) -> str:
    """No training data yet for this teacher — fall back to a generic
    pass with whatever rubric we have. The cold-start case."""
    parts = [
        f"You are grading a student essay. The teacher's name is {teacher}, but "
        f"you don't yet have prior examples of their grading style — fall back "
        f"to standard high-school / college English grading. Be specific and "
        f"constructive."
    ]
    if rubric:
        parts.append(f"\n--- RUBRIC ---\n{_truncate(rubric, 3000)}")
    parts.append(f"\n--- ESSAY ---\n{_truncate(essay, 8000)}")
    parts.append(
        "\n--- TASK ---\n"
        "Output ONLY a JSON object:\n"
        '  "line_by_line": array of {"quote": "...", "comment": "..."}\n'
        '  "overall_feedback": string\n'
        '  "grade": string (letter grade or percent)\n'
        '  "rubric_breakdown": object | null\n'
        "Quote phrases that actually appear verbatim in the essay."
    )
    return "\n".join(parts)
