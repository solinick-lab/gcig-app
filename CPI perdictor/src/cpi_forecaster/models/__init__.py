"""Three independently-trained forecasters that all return a 3-month
ahead prediction in log-MoM-percent space, plus point and interval data.
"""

from .sarima import SarimaForecaster
from .ridge import RidgeForecaster
from .xgb import XgbForecaster

__all__ = ["SarimaForecaster", "RidgeForecaster", "XgbForecaster"]
