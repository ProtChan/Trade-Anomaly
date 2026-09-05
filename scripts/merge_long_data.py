#!/usr/bin/env python3
"""Long-history entry point for merge_data without changing its ingestion logic."""

import os
import merge_data

merge_data.KEEP_DAYS = int(os.getenv("KEEP_DAYS", "3650"))
merge_data.DATASET_VERSION = max(int(getattr(merge_data, "DATASET_VERSION", 0)), 6)

if __name__ == "__main__":
    merge_data.main()
