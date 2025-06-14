# Prompt Clustering Report

Generated by `cluster_prompts.py` – 2025-04-16

## Overview

- Total prompts: **213**
- Clustering method: **dbscan**
- Final clusters (excluding noise): **1**

| label | name                  | #prompts | description                                                                                                                                                                                                                                                                                                                                     |
| ----- | --------------------- | -------: | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| -1    | Noise / Outlier       |       10 | Prompts that do not cleanly belong to any cluster.                                                                                                                                                                                                                                                                                              |
| 0     | Role Simulation Tasks |      203 | This cluster consists of varied role-playing scenarios where users request an AI to assume specific professional roles, such as composer, dream interpreter, doctor, or IT architect. Each snippet showcases tasks that involve creating content, providing advice, or performing analytical functions based on user-defined themes or prompts. |

---

## Plots

The directory `plots/` contains a bar chart of the cluster sizes and a t‑SNE scatter plot coloured by cluster.
