# Shipwright

An AI coding platform I'm building to fix bugs in existing repos and scaffold new
projects from a spec. The interesting part isn't the agent loop, it's measuring whether
any of it actually works.

## Why

I went in assuming coding agents were hard to build, then found mini-swe-agent: about
100 lines of Python, one tool (bash), no tool-calling API, and it scores over 74% on
SWE-bench Verified. Frontier models under that same minimal setup land around 76%.
Elaborate scaffolds buy maybe 3-5 points on top.

So "better agent loop" is not a real problem anymore. Three things still look unsolved:

Retrieval is mostly grep and embeddings. A graph built from the AST, who calls what,
who imports what, does measurably better at finding the function that's actually broken.
I want that on my own numbers rather than a paper's.

Nobody publishes scaffold versus model cleanly. Papers change both at once, so you can't
tell which one moved the score. Holding the model fixed and swapping only the
architecture is cheap to run and as far as I can tell nobody has done it properly.

Cost gets left out. Leaderboards report resolve rate and skip the bill. One agent on
Princeton's HAL leaderboard spent $585 and resolved nothing. Dollars per resolved issue
belongs next to every score.

I'm also not using SWE-bench Verified as the headline benchmark. It sits around 95% now,
and there's a paper showing models can name the buggy file from the issue text alone on
those repos, which means part of the score is memorization. SWE-bench-Live pulls fresh
GitHub issues instead, and the same agents drop to roughly 63%. That gap is the more
honest number.

## Status

Early, but there are real numbers now.

Localization on Loc-Bench, 15 tasks, all six modes over the same task list, everything
running locally on a 7B at zero cost:

| mode | file@5 | func@10 |
|---|---|---|
| BM25 only | 60.0% | 20.0% |
| hybrid (BM25 + code graph) | 60.0% | 26.7% |
| + LLM extract & rerank | **73.3%** | **40.0%** |

The two LLM steps fix different things: extracting symbol names from the issue finds the
right file, reranking picks the right function inside it. Together they double plain BM25
at function level.

n=15, so one task is 6.7 points — the ordering across six modes convinces me more than any
single gap, and I'll run the full 560 before claiming anything firmer. For scale, LocAgent
reports 94.16% file / 77.37% function with a frontier model driving the traversal.

Bug fixing is a different story: the local 7B resolves 0/2 SWE-bench-Live tasks so far, for
reasons I understand and wrote down rather than hand-waved.

## Running it

Needs an Apple Silicon Mac, Docker (I use Colima), Ollama, and uv.

```bash
make bootstrap   # uv sync, copy .env
make up          # postgres + redis
make db-init     # create tables
make doctor      # check everything
```

`doctor` checks Postgres, Redis, and the Docker daemon, then actually generates tokens
through Ollama. A green row for Ollama means inference works, not that a port answered.

## Speed on my laptop

M5, 10 cores, 16 GB, running `qwen2.5-coder:7b` at Q4 through Metal. First request after
the model loads takes about 5 seconds. Warm, it's 373ms to first token and around 23
tokens/sec.

That number shaped the plan more than anything else. At 23 tok/s a 30-step agent run is
ten minutes, so grinding 300 SWE-bench tasks locally isn't happening. Localization is
different: one prompt, a short answer, scored against known file and function labels, no
containers and no test suites. So the free local tier measures retrieval quality, and
anything that needs real resolve rates moves to a cheap API later.

## Layout

```
src/shipwright/
  config.py     settings from env
  db.py         engine, session, create_all
  models.py     runs / task_results / model_calls
  gateway/      model access, Ollama is the local tier
  cli.py        sw doctor, sw db-init
```

Those three tables are the whole reason the schema exists. Every number I publish has to
come from a row in them, which is also why token and latency logging went in before any
benchmark did.

## Things I'm holding myself to

No invented numbers. If a benchmark hasn't run, it says it hasn't run.

Benchmarks are public ones, so a score means something to someone who isn't me. A
private task suite I wrote myself would prove nothing.

The sandbox is a Docker container and I call it a container. It isn't a microVM and it
isn't safe for repos you don't trust. Firecracker needs Linux and KVM, so that comes
later on an actual Linux host, behind the same interface.

## Not done yet

Sandbox provider, the code graph, the agent loop, the web UI, benchmark runners, and the
fine-tune. Roughly in that order.
